/**
 * Schema for the market layer: inventory, corrections and external keys.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * The two backends each carry their own `ddl()`, which is right for tables that
 * predate this work and would be churn to move. New tables should not repeat
 * that: one definition, two dialects, and a type map that is the ONLY thing
 * allowed to differ. A schema written twice drifts, and a schema that drifts
 * between SQLite and Postgres is discovered in production by the deployment that
 * uses the other one.
 *
 * THREE CONSTRAINTS DOING REAL WORK
 * ---------------------------------
 *   market_inventory PRIMARY KEY (tenant_id, participant, sku)
 *     One row per company per SKU. Two rows would mean two answers to "how many
 *     do you have", which is the oversell this whole layer exists to prevent —
 *     so the database refuses to hold a second one.
 *
 *   market_corrections UNIQUE (tenant_id, trade_id, kind)
 *     A refund commits exactly once. Not "the code checks first" — the database
 *     rejects the second insert, so a retried request, a duplicated queue
 *     message and a double-clicked button all land on the same row rather than
 *     paying a buyer twice.
 *
 *   market_inventory CHECK (committed >= 0 AND on_hand >= 0)
 *     The application already refuses these, and the check is here anyway. A
 *     negative committed count means a release ran twice; catching it at the
 *     write makes it a failed transaction instead of a silent hole in the book.
 */

export type Dialect = 'sqlite' | 'postgres';

const types = (dialect: Dialect) => ({
  /** SQLite has one integer type and it is already 64-bit. */
  big: dialect === 'postgres' ? 'BIGINT' : 'INTEGER',
  int: 'INTEGER',
  text: 'TEXT',
});

export const MARKET_TABLES = ['market_inventory', 'market_listings', 'market_corrections', 'external_keys'] as const;

export function marketDdl(dialect: Dialect): string[] {
  const t = types(dialect);

  return [
    `CREATE TABLE IF NOT EXISTS market_inventory (
       tenant_id    ${t.text} NOT NULL,
       participant  ${t.text} NOT NULL,
       sku          ${t.text} NOT NULL,
       kind         ${t.text} NOT NULL,
       on_hand      ${t.int}  NOT NULL DEFAULT 0,
       committed    ${t.int}  NOT NULL DEFAULT 0,
       delivered    ${t.int}  NOT NULL DEFAULT 0,
       period_start ${t.big},
       period_end   ${t.big},
       issuance_cap ${t.int},
       issued       ${t.int}  NOT NULL DEFAULT 0,
       updated_at   ${t.big}  NOT NULL,
       PRIMARY KEY (tenant_id, participant, sku),
       CHECK (on_hand >= 0 AND committed >= 0 AND delivered >= 0 AND issued >= 0)
     )`,

    /*
     * How many times a participant has listed a SKU.
     *
     * This is what makes "more than once" answerable at the moment a listing is
     * posted. Without it `requireAccounting` has to be told the prior count by
     * its caller, and a rule whose input the caller supplies is a rule the
     * caller can switch off.
     */
    `CREATE TABLE IF NOT EXISTS market_listings (
       tenant_id   ${t.text} NOT NULL,
       participant ${t.text} NOT NULL,
       sku         ${t.text} NOT NULL,
       listings    ${t.int}  NOT NULL DEFAULT 0,
       first_at    ${t.big}  NOT NULL,
       last_at     ${t.big}  NOT NULL,
       PRIMARY KEY (tenant_id, participant, sku)
     )`,

    `CREATE TABLE IF NOT EXISTS market_corrections (
       tenant_id  ${t.text} NOT NULL,
       id         ${t.text} NOT NULL,
       trade_id   ${t.text} NOT NULL,
       kind       ${t.text} NOT NULL,
       legs       ${t.text} NOT NULL,
       digest     ${t.text} NOT NULL,
       reason     ${t.text} NOT NULL,
       decided_by ${t.text} NOT NULL,
       created_at ${t.big}  NOT NULL,
       PRIMARY KEY (tenant_id, id),
       UNIQUE (tenant_id, trade_id, kind)
     )`,

    `CREATE TABLE IF NOT EXISTS external_keys (
       key_id          ${t.text} PRIMARY KEY,
       tenant_id       ${t.text} NOT NULL,
       secret_hash     ${t.text} NOT NULL,
       label           ${t.text} NOT NULL,
       scopes          ${t.text} NOT NULL,
       created_at      ${t.big}  NOT NULL,
       expires_at      ${t.big},
       revoked_at      ${t.big},
       rate_per_minute ${t.int}  NOT NULL DEFAULT 60
     )`,

    `CREATE INDEX IF NOT EXISTS idx_market_corrections_trade ON market_corrections (tenant_id, trade_id)`,
    `CREATE INDEX IF NOT EXISTS idx_external_keys_tenant ON external_keys (tenant_id)`,
  ];
}

export function marketDropSql(): string[] {
  return [...MARKET_TABLES].reverse().map((table) => `DROP TABLE IF EXISTS ${table}`);
}

/**
 * Postgres row-level security.
 *
 * WHY THIS EXISTS WHEN EVERY QUERY IS ALREADY SCOPED
 * --------------------------------------------------
 * `SqlStore` cannot read a scoped table without a tenant, because no method
 * signature permits it. That is a good control and it protects exactly one
 * thing: code that goes through `SqlStore`. It does nothing for a migration
 * script, an analytics job, a psql session, a future ORM, or an SQL injection
 * that gets as far as the driver.
 *
 * RLS moves the boundary from "the code is careful" to "the database refuses".
 * The two are worth having together: defence in depth means the second control
 * assumes the first has already failed.
 *
 * HOW IT IS ENFORCED
 * ------------------
 * Each policy compares `tenant_id` against `current_setting('apex.tenant_id')`.
 * The application sets that per transaction. FORCE ROW LEVEL SECURITY is
 * included deliberately: without it, the table OWNER bypasses every policy, and
 * the application usually connects as the owner — which is how RLS gets
 * switched on, tested, and quietly does nothing.
 *
 * A missing setting yields '' and matches no tenant, so the failure mode is an
 * empty result rather than an unscoped one.
 */
export const RLS_SETTING = 'apex.tenant_id';
/**
 * The escape hatch, and it is deliberately a separate setting rather than a
 * magic tenant value. Boot-time and operator paths that legitimately have no
 * tenant set it; anything reachable from a request does not. Keeping it
 * separate means "is this query bypassing isolation" is one grep, not a
 * comparison against a sentinel string somebody could also pass as a tenant id.
 */
export const RLS_SYSTEM_SETTING = 'apex.system';

/** Tables carrying a tenant_id that RLS should cover. */
export const RLS_TABLES = [
  'users',
  'twin_nodes',
  'assets',
  'trades',
  'audit_log',
  'orders',
  'fills',
  'meta',
  'ai_usage',
  'market_inventory',
  'market_listings',
  'market_corrections',
  /*
   * external_keys is DELIBERATELY ABSENT.
   *
   * A presented API key is looked up by its public handle before any tenant is
   * known — that lookup IS what establishes the tenant. A tenant policy on this
   * table would require knowing the answer in order to ask the question, and
   * the only ways out are worse: look it up under a system scope on every
   * request (a bypass on the hottest authentication path) or cache it (a
   * revocation that takes effect "shortly").
   *
   * The row itself carries no customer data — a key id, a hash, a label and a
   * scope list — and every query against it is by primary key. Isolation for
   * this table is the hash: possession of the secret is the only thing that
   * makes a row useful.
   */
] as const;

export function marketRlsSql(tables: readonly string[] = RLS_TABLES): string[] {
  const statements: string[] = [];
  for (const table of tables) {
    statements.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    // Without FORCE, the owner — which is who the app connects as — bypasses
    // every policy below and RLS becomes decoration.
    statements.push(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    statements.push(`DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${table}`);
    /*
     * USING filters what a query can SEE; WITH CHECK constrains what it may
     * WRITE — a tenant scoped to their own rows must not be able to INSERT a
     * row stamped with someone else's tenant_id, which is a quieter and nastier
     * bug than reading one.
     *
     * Stated explicitly even though Postgres would reuse the USING expression
     * if WITH CHECK were omitted. The default is the behaviour we want, and a
     * policy whose write rule is implicit is one that silently changes meaning
     * the day somebody adds a WITH CHECK for an unrelated reason.
     */
    const predicate =
      `(tenant_id = current_setting('${RLS_SETTING}', true) ` +
      `OR current_setting('${RLS_SYSTEM_SETTING}', true) = 'on')`;
    statements.push(
      `CREATE POLICY ${table}_tenant_isolation ON ${table}
         USING ${predicate}
         WITH CHECK ${predicate}`,
    );
  }
  return statements;
}
