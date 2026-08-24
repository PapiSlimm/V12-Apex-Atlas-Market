/**
 * Apply Postgres row-level security.
 *
 * WHY THIS IS A SEPARATE STEP AND NOT PART OF BOOT
 * -----------------------------------------------
 * Enabling RLS requires table ownership. A hardened deployment runs the
 * application as a limited role that does not have it — which is the right
 * setup and means a boot-time attempt would fail, log a permission error nobody
 * reads, and leave the operator believing RLS is on. Making it an explicit,
 * privileged, one-time act means its success or failure is something a person
 * saw.
 *
 *   DATABASE_URL=postgres://owner@host/db npm run rls:apply
 *   DATABASE_URL=… npm run rls:apply -- --check
 *
 * SQLite has no RLS. It is a single-file, single-process database where the
 * application IS the boundary, so this refuses rather than pretending.
 */

import { createStore } from '../server/store';
import { PostgresStore } from '../server/store/postgres';
import { RLS_SETTING, RLS_TABLES } from '../server/store/market-schema';

const checkOnly = process.argv.includes('--check');
const acknowledged = process.argv.includes('--connections-are-scoped');

/*
 * THE PRECONDITION, AND WHY THIS SCRIPT REFUSES WITHOUT IT
 * -------------------------------------------------------
 * FORCE ROW LEVEL SECURITY means the application's own connection is subject to
 * the policies — which is the entire point, because the app connects as the
 * table owner and an unFORCEd policy would let injection straight through.
 *
 * The consequence is that every scoped query must run with apex.tenant_id set,
 * via PostgresStore.withTenant(). Today `SqlStore` scopes by WHERE clause and
 * does NOT set that GUC, so applying this to a live deployment would make every
 * query return nothing — an outage, not a hardening.
 *
 * So this refuses unless the operator states that connection scoping is in
 * place. A destructive step that can be taken by accident is a step that will
 * be taken by accident.
 */

async function main(): Promise<void> {
  const store = await createStore();

  try {
    if (!(store instanceof PostgresStore)) {
      console.error(
        '\n  This deployment is on SQLite, which has no row-level security.\n' +
          '  A single-file database in one process has the application as its boundary;\n' +
          '  there is nothing here for RLS to defend against. Point DATABASE_URL at\n' +
          '  Postgres before running this.\n',
      );
      process.exit(1);
    }

    if (checkOnly) {
      console.log(`\n  Would apply tenant isolation to ${RLS_TABLES.length} tables:\n`);
      for (const table of RLS_TABLES) console.log(`    ${table}`);
      console.log(
        `\n  Each gets ENABLE + FORCE ROW LEVEL SECURITY and a policy comparing\n` +
          `  tenant_id against current_setting('${RLS_SETTING}').\n\n` +
          '  FORCE matters: without it the table owner — which is who the app usually\n' +
          '  connects as — bypasses every policy, and RLS becomes decoration.\n',
      );
      return;
    }

    if (!acknowledged) {
      console.error(
        '\n  REFUSED — connection scoping is not confirmed.\n\n' +
          '  FORCE ROW LEVEL SECURITY applies to the application\'s own connection.\n' +
          '  Every scoped query must therefore run inside PostgresStore.withTenant(),\n' +
          `  which sets ${RLS_SETTING} transaction-locally. SqlStore currently scopes\n` +
          '  by WHERE clause only, so applying this now would make every query return\n' +
          '  nothing — an outage, not a hardening.\n\n' +
          '  Route your queries through withTenant() first, then re-run with\n' +
          '  --connections-are-scoped to confirm you have done so.\n\n' +
          '  Run with --check to see exactly what would be applied.\n',
      );
      process.exit(1);
    }

    const result = await store.applyRowLevelSecurity();
    console.log(`\n  Row-level security applied: ${result.applied} statements across ${RLS_TABLES.length} tables.\n`);

    if (result.superuser) {
      console.error(
        '  ⚠  THIS CONNECTION IS A SUPERUSER, AND SUPERUSERS BYPASS RLS ENTIRELY.\n\n' +
          '     The policies are applied and they will do NOTHING for this role — every\n' +
          '     query still returns every tenant\'s rows, with no error and no warning.\n' +
          '     Create a non-superuser owner for the application and connect as that:\n\n' +
          '       CREATE ROLE apex LOGIN NOSUPERUSER;\n' +
          '       ALTER DATABASE <db> OWNER TO apex;\n\n' +
          '     Managed Postgres (Render, RDS) already gives you a non-superuser owner.\n',
      );
      process.exitCode = 1;
    }

    console.log(`  Every scoped query must now run inside withTenant(), which sets`);
    console.log(`  ${RLS_SETTING} transaction-locally. A query with the setting unset`);
    console.log('  returns nothing rather than everything — the failure mode is an empty');
    console.log('  result, never an unscoped one.\n');
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
