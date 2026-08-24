import { Pool, type PoolClient } from 'pg';
import { AsyncLocalStorage } from 'async_hooks';
import { SqlStore, type Row } from './sql-store';
import { marketDdl, marketDropSql, marketRlsSql, RLS_SETTING, RLS_SYSTEM_SETTING } from './market-schema';
import { runWithTenant, scopeSettings } from './tenant-context';

/**
 * Production backend. Set `DATABASE_URL` to select it.
 *
 * Shares every query string with the SQLite backend; only placeholder syntax,
 * DDL types and locking differ. Both are run against the same conformance suite
 * so the two cannot silently diverge.
 */
export class PostgresStore extends SqlStore {
  readonly dialect = 'postgres' as const;
  private pool: Pool;

  /**
   * Carries the transaction's client through the async call stack, so the
   * shared `SqlStore` methods do not need to thread a connection parameter
   * through every signature. Without this, a query issued inside
   * `transaction()` could be checked out on a different pooled connection and
   * silently run outside the transaction — which for the audit chain would mean
   * appends that look committed but are not covered by the lock.
   */
  private txClient = new AsyncLocalStorage<PoolClient>();

  constructor(connectionString: string, ssl?: boolean) {
    super();
    this.pool = new Pool({
      connectionString,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.PGPOOL_MAX) || 10,
      idleTimeoutMillis: 30_000,
    });
  }

  /** `?` → `$1, $2, …` so query strings stay dialect-neutral. */
  private static toPgPlaceholders(sql: string): string {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  /**
   * Set the RLS scope on a client, transaction-locally.
   *
   * `set_config(..., true)` is local to the current transaction, so the setting
   * cannot survive back into the pool. That is not a detail: a session-level
   * setting on a pooled connection is exactly how an RLS deployment starts
   * serving one tenant's rows to the next borrower under load.
   */
  private static async applyScope(client: PoolClient): Promise<void> {
    const scope = scopeSettings();
    if (!scope) return;
    await client.query(`SELECT set_config('${RLS_SETTING}', $1, true)`, [scope.tenantId]);
    if (scope.system) await client.query(`SELECT set_config('${RLS_SYSTEM_SETTING}', 'on', true)`);
  }

  /**
   * Run one statement with the current scope applied.
   *
   * Inside a transaction the scope was set at BEGIN and the client is reused.
   * Outside one, a scoped statement is wrapped in its own transaction — because
   * the setting has to be transaction-local to be safe, and a transaction is
   * the only thing that bounds it. Unscoped statements (schema creation, the
   * tenants table itself) take the pool directly and cost nothing extra.
   */
  private async run(sql: string, params: unknown[]): Promise<{ rows: Row[]; rowCount: number }> {
    const text = PostgresStore.toPgPlaceholders(sql);

    const inTransaction = this.txClient.getStore();
    if (inTransaction) {
      const result = await inTransaction.query(text, params);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
    }

    if (!scopeSettings()) {
      const result = await this.pool.query(text, params);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await PostgresStore.applyScope(client);
      const result = await client.query(text, params);
      await client.query('COMMIT');
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  protected async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.run(sql, params)).rows as T[];
  }

  protected async exec(sql: string, params: unknown[] = []): Promise<void> {
    await this.run(sql, params);
  }

  protected async execCount(sql: string, params: unknown[] = []): Promise<number> {
    return (await this.run(sql, params)).rowCount;
  }

  protected async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The scope goes on before anything reads or writes, so every statement
      // in the transaction — including the audit append — is subject to it.
      await PostgresStore.applyScope(client);
      // Serialises audit appends against each other. Appends are infrequent and
      // a fork in the hash chain is unrecoverable, so the lock is the right
      // trade.
      await client.query('LOCK TABLE audit_log IN EXCLUSIVE MODE');
      const result = await this.txClient.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  protected async tableExists(table: string): Promise<boolean> {
    const rows = await this.query(
      'SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?',
      [table],
    );
    return rows.length > 0;
  }

  protected async columnsOf(table: string): Promise<string[]> {
    const rows = await this.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?',
      [table],
    );
    return rows.map((r) => String(r.column_name));
  }

  protected ddl(): string[] {
    return [
      `CREATE TABLE IF NOT EXISTS tenants (
         id                      TEXT PRIMARY KEY,
         slug                    TEXT NOT NULL UNIQUE,
         name                    TEXT NOT NULL,
         plan                    TEXT NOT NULL,
         status                  TEXT NOT NULL DEFAULT 'active',
         seat_limit              INTEGER NOT NULL DEFAULT 1,
         monthly_ai_credit_cents INTEGER NOT NULL DEFAULT 0,
         trading_enabled         INTEGER NOT NULL DEFAULT 0,
         created_at              TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS users (
         id            TEXT PRIMARY KEY,
         tenant_id     TEXT NOT NULL,
         email         TEXT NOT NULL UNIQUE,
         name          TEXT NOT NULL,
         password_hash TEXT NOT NULL,
         role          TEXT NOT NULL,
         created_at    TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS twin_nodes (
         id              TEXT NOT NULL,
         tenant_id       TEXT NOT NULL,
         name            TEXT NOT NULL,
         type            TEXT NOT NULL,
         node_id         TEXT NOT NULL,
         parent_hub      TEXT,
         file_path       TEXT NOT NULL,
         coordinates     TEXT,
         connected_nodes TEXT NOT NULL DEFAULT '[]',
         metrics         TEXT NOT NULL DEFAULT '{}',
         content         TEXT NOT NULL,
         sort_order      INTEGER NOT NULL DEFAULT 0,
         updated_at      TEXT,
         updated_by      TEXT,
         PRIMARY KEY (tenant_id, id)
       )`,
      `CREATE TABLE IF NOT EXISTS assets (
         asset_id            TEXT NOT NULL,
         tenant_id           TEXT NOT NULL,
         name                TEXT NOT NULL,
         asset_class         TEXT NOT NULL,
         acquisition_price   DOUBLE PRECISION NOT NULL,
         current_price       DOUBLE PRECISION NOT NULL,
         buy_fees            DOUBLE PRECISION NOT NULL,
         sell_fees           DOUBLE PRECISION NOT NULL,
         is_guaranteed       INTEGER NOT NULL DEFAULT 0,
         fundamentals_intact INTEGER NOT NULL DEFAULT 1,
         quantity            DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (quantity >= 0),
         active_offer        DOUBLE PRECISION,
         simulated           INTEGER NOT NULL DEFAULT 1,
         sort_order          INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (tenant_id, asset_id)
       )`,
      `CREATE TABLE IF NOT EXISTS trades (
         id                    TEXT PRIMARY KEY,
         tenant_id             TEXT NOT NULL,
         asset_id              TEXT NOT NULL,
         action                TEXT NOT NULL,
         quantity              DOUBLE PRECISION NOT NULL,
         unit_price            DOUBLE PRECISION NOT NULL,
         realized_net_per_unit DOUBLE PRECISION NOT NULL,
         realized_net_total    DOUBLE PRECISION NOT NULL,
         executed_by           TEXT NOT NULL,
         executed_by_id        TEXT NOT NULL,
         timestamp             TEXT NOT NULL,
         simulated             INTEGER NOT NULL DEFAULT 1
       )`,
      `CREATE TABLE IF NOT EXISTS audit_log (
         tenant_id  TEXT NOT NULL,
         seq        BIGINT NOT NULL,
         id         TEXT NOT NULL UNIQUE,
         timestamp  TEXT NOT NULL,
         event      TEXT NOT NULL,
         actor_id   TEXT,
         actor_name TEXT,
         actor_role TEXT,
         subject    TEXT,
         outcome    TEXT NOT NULL,
         detail     TEXT NOT NULL DEFAULT '{}',
         prev_hash  TEXT NOT NULL,
         hash       TEXT NOT NULL,
         PRIMARY KEY (tenant_id, seq)
       )`,
      `CREATE TABLE IF NOT EXISTS orders (
         id                 TEXT PRIMARY KEY,
         tenant_id          TEXT NOT NULL,
         client_order_id    TEXT NOT NULL UNIQUE,
         symbol             TEXT NOT NULL,
         side               TEXT NOT NULL,
         quantity           DOUBLE PRECISION NOT NULL,
         order_type         TEXT NOT NULL,
         limit_price        DOUBLE PRECISION,
         time_in_force      TEXT NOT NULL,
         reason             TEXT NOT NULL DEFAULT '',
         status             TEXT NOT NULL,
         venue_order_id     TEXT,
         filled_quantity    DOUBLE PRECISION NOT NULL DEFAULT 0,
         average_fill_price DOUBLE PRECISION NOT NULL DEFAULT 0,
         fees_paid          DOUBLE PRECISION NOT NULL DEFAULT 0,
         created_at         TEXT NOT NULL,
         updated_at         TEXT NOT NULL,
         actor_id           TEXT,
         actor_name         TEXT,
         venue              TEXT NOT NULL,
         mode               TEXT NOT NULL,
         reject_reason      TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS fills (
         id              TEXT PRIMARY KEY,
         tenant_id       TEXT NOT NULL,
         client_order_id TEXT NOT NULL,
         venue_fill_id   TEXT NOT NULL UNIQUE,
         symbol          TEXT NOT NULL,
         side            TEXT NOT NULL,
         quantity        DOUBLE PRECISION NOT NULL,
         price           DOUBLE PRECISION NOT NULL,
         fee             DOUBLE PRECISION NOT NULL DEFAULT 0,
         timestamp       TEXT NOT NULL,
         received_at     TEXT NOT NULL,
         sequence        BIGINT
       )`,
      `CREATE TABLE IF NOT EXISTS meta (
         tenant_id TEXT NOT NULL,
         key       TEXT NOT NULL,
         value     TEXT NOT NULL,
         PRIMARY KEY (tenant_id, key)
       )`,
      `CREATE TABLE IF NOT EXISTS invites (
         id            TEXT PRIMARY KEY,
         code_hash     TEXT NOT NULL UNIQUE,
         label         TEXT,
         created_at    TEXT NOT NULL,
         created_by    TEXT,
         max_uses      INTEGER NOT NULL DEFAULT 1,
         uses          INTEGER NOT NULL DEFAULT 0,
         expires_at    TEXT,
         revoked_at    TEXT,
         last_used_at  TEXT,
         last_used_by  TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS ai_usage (
         tenant_id     TEXT NOT NULL,
         period        TEXT NOT NULL,
         requests      INTEGER NOT NULL DEFAULT 0,
         input_tokens  INTEGER NOT NULL DEFAULT 0,
         output_tokens INTEGER NOT NULL DEFAULT 0,
         cost_cents    DOUBLE PRECISION NOT NULL DEFAULT 0,
         updated_at    TEXT NOT NULL,
         PRIMARY KEY (tenant_id, period)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders (tenant_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_fills_tenant_order ON fills (tenant_id, client_order_id)`,
      `CREATE INDEX IF NOT EXISTS idx_fills_tenant_symbol ON fills (tenant_id, symbol)`,
      `CREATE INDEX IF NOT EXISTS idx_trades_tenant ON trades (tenant_id, timestamp DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_tenant_event ON audit_log (tenant_id, event)`,
      // Belt and braces: revoke the ability to rewrite history at the schema
      // level, not just by convention in application code.
      `CREATE OR REPLACE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING`,
      `CREATE OR REPLACE RULE audit_log_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING`,
      ...marketDdl('postgres'),
    ];
  }

  protected dropSql(): string[] {
    return [
      ...marketDropSql().map((s) => `${s} CASCADE`),
      ...['ai_usage', 'invites', 'audit_log', 'fills', 'orders', 'meta', 'trades', 'assets', 'twin_nodes', 'users', 'tenants'].map(
        (t) => `DROP TABLE IF EXISTS ${t} CASCADE`,
      ),
    ];
  }

  /**
   * Turn on row-level security.
   *
   * Separate from `init()` on purpose: enabling RLS requires table ownership,
   * and a deployment that runs the app as a limited role must apply this once
   * with a privileged connection rather than have every boot attempt it and log
   * a permission error nobody reads.
   */
  async applyRowLevelSecurity(): Promise<{ applied: number; superuser: boolean }> {
    /*
     * THE TRAP THIS CHECK EXISTS FOR
     * ------------------------------
     * A SUPERUSER bypasses row-level security entirely — FORCE included. Every
     * policy applies, `\d` shows them enabled, and every query still returns
     * every tenant's rows. Nothing errors. Nothing warns. The operator has a
     * green terminal and no isolation at all.
     *
     * I found this the way you would rather not: the first run of the RLS suite
     * passed the policy-text assertions and failed every isolation assertion,
     * because the test connected as `postgres`.
     *
     * So the fact is reported rather than assumed. Managed Postgres (Render,
     * RDS, Supabase) hands out a non-superuser owner, which is why this usually
     * only bites on a local or self-managed instance — the one place people
     * test it first.
     */
    const [role] = await this.query<{ superuser: boolean }>(
      'SELECT rolsuper AS superuser FROM pg_roles WHERE rolname = current_user',
    );
    const superuser = role?.superuser === true;

    const statements = marketRlsSql();
    for (const statement of statements) await this.exec(statement);
    return { applied: statements.length, superuser };
  }

  /**
   * Scope a unit of work to one tenant at the DATABASE level.
   *
   * `set_config(..., true)` is transaction-local, so the setting cannot leak to
   * the next borrower of a pooled connection — which is the classic way an RLS
   * deployment ends up serving one tenant's rows to another under load.
   */
  async withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return runWithTenant(tenantId, () => this.transaction(fn));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
