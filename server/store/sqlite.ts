import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { SqlStore, type Row } from './sql-store';
import { marketDdl, marketDropSql } from './market-schema';

/**
 * Default backend. Zero configuration, real transactions, real constraints, and
 * durable across restarts — which the previous JSON store was not. Suitable for
 * single-node deployments; point `DATABASE_URL` at Postgres to scale out.
 */
export class SqliteStore extends SqlStore {
  readonly dialect = 'sqlite' as const;
  private db: Database.Database;

  constructor(file: string) {
    super();
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    // WAL lets readers proceed during a write, and NORMAL sync is the standard
    // durability/throughput trade for WAL mode.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    // Wait rather than fail if another connection holds the write lock.
    this.db.pragma('busy_timeout = 5000');
  }

  protected async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    // better-sqlite3 refuses `.all()` on statements that return nothing, but
    // UPDATE ... RETURNING does return rows, so ask the statement itself.
    if (!stmt.reader) {
      stmt.run(...(params as any[]));
      return [];
    }
    return stmt.all(...(params as any[])) as T[];
  }

  protected async exec(sql: string, params: unknown[] = []): Promise<void> {
    if (params.length === 0 && /;\s*$/.test(sql.trim()) === false && !/\?/.test(sql)) {
      this.db.prepare(sql).run();
      return;
    }
    this.db.prepare(sql).run(...(params as any[]));
  }

  protected async execCount(sql: string, params: unknown[] = []): Promise<number> {
    return this.db.prepare(sql).run(...(params as any[])).changes;
  }

  /**
   * Serialises transactions in-process, then runs each one under
   * BEGIN IMMEDIATE.
   *
   * The queue is not optional. better-sqlite3 is synchronous over a single
   * connection, but `transaction()` awaits its callback — so without a mutex a
   * second caller can BEGIN while the first is still open and SQLite rejects it
   * with "cannot start a transaction within a transaction". Two audit appends
   * landing in the same tick is enough to trigger it, which under real load
   * means dropped audit records. The conformance suite's concurrent-append test
   * exists to keep this honest.
   *
   * BEGIN IMMEDIATE (rather than deferred) takes the write lock up front, so
   * cross-process contention queues instead of failing on lock upgrade.
   */
  private txQueue: Promise<unknown> = Promise.resolve();

  protected transaction<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.db.prepare('BEGIN IMMEDIATE').run();
      try {
        const result = await fn();
        this.db.prepare('COMMIT').run();
        return result;
      } catch (err) {
        try {
          this.db.prepare('ROLLBACK').run();
        } catch {
          /* already rolled back */
        }
        throw err;
      }
    };

    // Chain onto the queue, and make sure a rejection does not poison it.
    const result = this.txQueue.then(run, run);
    this.txQueue = result.catch(() => undefined);
    return result;
  }

  protected async tableExists(table: string): Promise<boolean> {
    const rows = await this.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [table]);
    return rows.length > 0;
  }

  protected async columnsOf(table: string): Promise<string[]> {
    if (!(await this.tableExists(table))) return [];
    const rows = await this.query(`PRAGMA table_info(${table})`);
    return rows.map((r) => String(r.name));
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
         acquisition_price   REAL NOT NULL,
         current_price       REAL NOT NULL,
         buy_fees            REAL NOT NULL,
         sell_fees           REAL NOT NULL,
         is_guaranteed       INTEGER NOT NULL DEFAULT 0,
         fundamentals_intact INTEGER NOT NULL DEFAULT 1,
         quantity            REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0),
         active_offer        REAL,
         simulated           INTEGER NOT NULL DEFAULT 1,
         sort_order          INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (tenant_id, asset_id)
       )`,
      `CREATE TABLE IF NOT EXISTS trades (
         id                    TEXT PRIMARY KEY,
         tenant_id             TEXT NOT NULL,
         asset_id              TEXT NOT NULL,
         action                TEXT NOT NULL,
         quantity              REAL NOT NULL,
         unit_price            REAL NOT NULL,
         realized_net_per_unit REAL NOT NULL,
         realized_net_total    REAL NOT NULL,
         executed_by           TEXT NOT NULL,
         executed_by_id        TEXT NOT NULL,
         timestamp             TEXT NOT NULL,
         simulated             INTEGER NOT NULL DEFAULT 1
       )`,
      // No UPDATE or DELETE path exists in the application for this table.
      `CREATE TABLE IF NOT EXISTS audit_log (
         tenant_id  TEXT NOT NULL,
         seq        INTEGER NOT NULL,
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
         quantity           REAL NOT NULL,
         order_type         TEXT NOT NULL,
         limit_price        REAL,
         time_in_force      TEXT NOT NULL,
         reason             TEXT NOT NULL DEFAULT '',
         status             TEXT NOT NULL,
         venue_order_id     TEXT,
         filled_quantity    REAL NOT NULL DEFAULT 0,
         average_fill_price REAL NOT NULL DEFAULT 0,
         fees_paid          REAL NOT NULL DEFAULT 0,
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
         quantity        REAL NOT NULL,
         price           REAL NOT NULL,
         fee             REAL NOT NULL DEFAULT 0,
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
         cost_cents    REAL NOT NULL DEFAULT 0,
         updated_at    TEXT NOT NULL,
         PRIMARY KEY (tenant_id, period)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders (tenant_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_fills_tenant_order ON fills (tenant_id, client_order_id)`,
      `CREATE INDEX IF NOT EXISTS idx_fills_tenant_symbol ON fills (tenant_id, symbol)`,
      `CREATE INDEX IF NOT EXISTS idx_trades_tenant ON trades (tenant_id, timestamp DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_tenant_event ON audit_log (tenant_id, event)`,
      ...marketDdl('sqlite'),
    ];
  }

  protected dropSql(): string[] {
    return [
      ...marketDropSql(),
      ...['ai_usage', 'invites', 'audit_log', 'fills', 'orders', 'meta', 'trades', 'assets', 'twin_nodes', 'users', 'tenants'].map(
        (t) => `DROP TABLE IF EXISTS ${t}`,
      ),
    ];
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
