/**
 * Schema migration from the pre-tenancy layout.
 *
 * WHY THIS EXISTS
 * ---------------
 * The schema is created with `CREATE TABLE IF NOT EXISTS`, which is exactly
 * right for a fresh database and useless for an existing one: it silently does
 * nothing to a table that is already there. A deployment upgrading from the
 * previous version would boot "successfully" and then fail on the first query
 * with `column "tenant_id" does not exist`.
 *
 * I found this the way you would rather not: a Postgres test database left over
 * from before the change failed while the fresh SQLite one passed. Same code,
 * different history — which is precisely the shape of a bad deploy.
 *
 * STRATEGY
 * --------
 * Rename, recreate, copy. Legacy tables are renamed rather than dropped, so the
 * migration is reversible and a failure part-way through loses nothing. The
 * `_pre_tenancy` tables are left in place deliberately — deleting a customer's
 * only copy of their data to reclaim a few megabytes is a bad trade.
 */

import { DEFAULT_TENANT_ID, type TenantId } from './tenancy';

/** Tables that gained a `tenant_id` column, with the columns to carry across. */
const MIGRATIONS: { table: string; columns: string[] }[] = [
  { table: 'users', columns: ['id', 'email', 'name', 'password_hash', 'role', 'created_at'] },
  {
    table: 'twin_nodes',
    columns: [
      'id',
      'name',
      'type',
      'node_id',
      'parent_hub',
      'file_path',
      'coordinates',
      'connected_nodes',
      'metrics',
      'content',
      'sort_order',
      'updated_at',
      'updated_by',
    ],
  },
  {
    table: 'assets',
    columns: [
      'asset_id',
      'name',
      'asset_class',
      'acquisition_price',
      'current_price',
      'buy_fees',
      'sell_fees',
      'is_guaranteed',
      'fundamentals_intact',
      'quantity',
      'active_offer',
      'simulated',
      'sort_order',
    ],
  },
  {
    table: 'trades',
    columns: [
      'id',
      'asset_id',
      'action',
      'quantity',
      'unit_price',
      'realized_net_per_unit',
      'realized_net_total',
      'executed_by',
      'executed_by_id',
      'timestamp',
      'simulated',
    ],
  },
  {
    table: 'audit_log',
    columns: [
      'seq',
      'id',
      'timestamp',
      'event',
      'actor_id',
      'actor_name',
      'actor_role',
      'subject',
      'outcome',
      'detail',
      'prev_hash',
      'hash',
    ],
  },
  {
    table: 'orders',
    columns: [
      'id',
      'client_order_id',
      'symbol',
      'side',
      'quantity',
      'order_type',
      'limit_price',
      'time_in_force',
      'reason',
      'status',
      'venue_order_id',
      'filled_quantity',
      'average_fill_price',
      'fees_paid',
      'created_at',
      'updated_at',
      'actor_id',
      'actor_name',
      'venue',
      'mode',
      'reject_reason',
    ],
  },
  {
    table: 'fills',
    columns: [
      'id',
      'client_order_id',
      'venue_fill_id',
      'symbol',
      'side',
      'quantity',
      'price',
      'fee',
      'timestamp',
      'received_at',
      'sequence',
    ],
  },
  { table: 'meta', columns: ['key', 'value'] },
];

export const LEGACY_SUFFIX = '_pre_tenancy';

export interface MigrationHooks {
  tableExists(table: string): Promise<boolean>;
  columnsOf(table: string): Promise<string[]>;
  exec(sql: string, params?: unknown[]): Promise<void>;
  /** Recreate the current schema. */
  createSchema(): Promise<void>;
}

export interface MigrationReport {
  ran: boolean;
  migrated: { table: string; rows: number }[];
}

/**
 * Detects a pre-tenancy schema and upgrades it in place.
 *
 * Idempotent: on an already-migrated or fresh database it does nothing and
 * reports `ran: false`.
 */
export async function migrateToTenancy(
  hooks: MigrationHooks,
  tenantId: TenantId = DEFAULT_TENANT_ID,
): Promise<MigrationReport> {
  // The marker of a legacy database: a table that exists but has no tenant_id.
  const legacy: typeof MIGRATIONS = [];

  for (const migration of MIGRATIONS) {
    if (!(await hooks.tableExists(migration.table))) continue;
    const columns = await hooks.columnsOf(migration.table);
    if (columns.length > 0 && !columns.includes('tenant_id')) legacy.push(migration);
  }

  if (legacy.length === 0) return { ran: false, migrated: [] };

  console.warn(
    `[store] Pre-tenancy schema detected on ${legacy.length} table(s). Migrating into tenant ${tenantId}. ` +
      `Original tables are preserved with the ${LEGACY_SUFFIX} suffix.`,
  );

  // Step 1: move every legacy table aside. Do this for ALL of them before
  // creating anything, so a failure leaves a consistent "all old" state rather
  // than a half-new one.
  for (const { table } of legacy) {
    await hooks.exec(`ALTER TABLE ${table} RENAME TO ${table}${LEGACY_SUFFIX}`);
  }

  // Step 2: build the current schema fresh.
  await hooks.createSchema();

  // Step 3: copy the data in, stamping the tenant.
  const migrated: MigrationReport['migrated'] = [];

  for (const { table, columns } of legacy) {
    const source = `${table}${LEGACY_SUFFIX}`;
    const available = await hooks.columnsOf(source);
    // Only carry columns that actually exist in the old table — an older
    // deployment may predate some of them.
    const carried = columns.filter((c) => available.includes(c));
    if (carried.length === 0) continue;

    const columnList = carried.join(', ');
    await hooks.exec(
      `INSERT INTO ${table} (tenant_id, ${columnList}) SELECT ?, ${columnList} FROM ${source}`,
      [tenantId],
    );

    migrated.push({ table, rows: -1 }); // row count is reported by the caller if needed
  }

  console.warn(
    `[store] Migration complete: ${migrated.map((m) => m.table).join(', ')}. ` +
      `Verify your data, then drop the ${LEGACY_SUFFIX} tables when you are satisfied.`,
  );

  return { ran: true, migrated };
}
