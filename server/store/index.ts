import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { PostgresStore } from './postgres';
import { seedAssets, seedNodes } from '../seed';
import { runAsSystem } from './tenant-context';
import type { Store, UserRecord } from './types';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
  PLAN_DEFAULTS,
  asTenantId,
  slugify,
  type Tenant,
  type TenantId,
  type TenantPlan,
} from './tenancy';

export * from './types';
export { verifyChain, hashEntry, canonicalise, GENESIS_HASH } from './chain';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const LEGACY_JSON = path.join(DATA_DIR, 'apex-atlas.json');

/**
 * Backend selection:
 *   DATABASE_URL set  → Postgres
 *   otherwise         → SQLite at $DATA_DIR/apex-atlas.db
 *
 * SQLite is loaded LAZILY and `better-sqlite3` is an optional dependency. It
 * compiles a native addon, which means a build toolchain and a reachable
 * prebuild host — neither of which a Postgres deployment should be made to care
 * about. Importing it eagerly would force every container image to carry a C++
 * compiler for a driver it never uses.
 */
export async function createStore(): Promise<Store> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const ssl = process.env.PGSSL === 'true' || /[?&]sslmode=require/.test(url);
    return new PostgresStore(url, ssl);
  }

  const file = process.env.SQLITE_PATH || path.join(DATA_DIR, 'apex-atlas.db');
  try {
    const { SqliteStore } = await import('./sqlite');
    return new SqliteStore(file);
  } catch (err) {
    throw new Error(
      'No DATABASE_URL is set, so the SQLite backend is required — but better-sqlite3 could not be loaded. ' +
        'Either set DATABASE_URL to a Postgres connection string, or install the optional dependency ' +
        `(npm install better-sqlite3). Underlying error: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Create a tenant with the limits its plan entitles. */
export async function createTenant(
  store: Store,
  input: { name: string; plan?: TenantPlan; slug?: string; id?: TenantId },
): Promise<Tenant> {
  const plan = input.plan ?? 'explorer';
  const defaults = PLAN_DEFAULTS[plan];

  let slug = input.slug ?? slugify(input.name);
  // Slugs are user-visible and unique; disambiguate rather than collide.
  if (await store.tenants.getBySlug(slug)) slug = `${slug}-${crypto.randomUUID().slice(0, 6)}`;

  const tenant: Tenant = {
    id: input.id ?? asTenantId(`tnt-${crypto.randomUUID()}`),
    slug,
    name: input.name.trim().slice(0, 120),
    plan,
    status: 'active',
    seatLimit: defaults.seatLimit,
    monthlyAiCreditCents: defaults.monthlyAiCreditCents,
    assetLedgerEnabled: defaults.assetLedgerEnabled,
    createdAt: new Date().toISOString(),
  };

  await store.tenants.create(tenant);
  await store.bootstrap.seed(tenant.id, seedNodes(), seedAssets());
  return tenant;
}

/**
 * One-time import of the pre-tenancy JSON store into the default tenant.
 * The file is renamed rather than deleted so the import is reversible.
 */
async function importLegacyJson(store: Store, tenantId: TenantId): Promise<boolean> {
  if (!fs.existsSync(LEGACY_JSON)) return false;

  try {
    const raw = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8'));
    const nodes = Array.isArray(raw.nodes) && raw.nodes.length ? raw.nodes : seedNodes();
    const assets = Array.isArray(raw.assets) && raw.assets.length ? raw.assets : seedAssets();

    await store.bootstrap.seed(tenantId, nodes, assets);

    if (Array.isArray(raw.users)) {
      // Pre-tenancy users had no tenant; they all belong to the default one.
      await store.bootstrap.importUsers(
        raw.users.map((u: Omit<UserRecord, 'tenantId'>) => ({ ...u, tenantId })),
      );
    }
    if (Array.isArray(raw.trades)) await store.bootstrap.importTrades(tenantId, raw.trades);

    await store.audit.append(tenantId, {
      event: 'store.migrated',
      actorId: null,
      actorName: 'system',
      actorRole: null,
      subject: LEGACY_JSON,
      outcome: 'info',
      detail: {
        users: raw.users?.length ?? 0,
        nodes: nodes.length,
        assets: assets.length,
        trades: raw.trades?.length ?? 0,
        from: 'json',
      },
    });

    fs.renameSync(LEGACY_JSON, `${LEGACY_JSON}.imported`);
    console.log(`[store] Imported legacy JSON store; original kept at ${LEGACY_JSON}.imported`);
    return true;
  } catch (err) {
    console.error('[store] Legacy import failed; continuing with seed data:', err);
    return false;
  }
}

/** Demo accounts, only when explicitly enabled. */
async function seedDemoUsers(store: Store, tenantId: TenantId): Promise<void> {
  if (process.env.ENABLE_DEMO_USERS !== 'true') return;
  if ((await store.users.countForTenant(tenantId)) > 0) return;

  const password = process.env.DEMO_PASSWORD || 'macaron2026';
  const now = new Date().toISOString();
  const demo: UserRecord[] = [
    {
      id: 'usr-demo-exec',
      tenantId,
      email: 'alex.atlas@apex.v12',
      name: 'Alex Atlas (Chief Architect)',
      passwordHash: bcrypt.hashSync(password, 10),
      role: 'Executive',
      createdAt: now,
    },
    {
      id: 'usr-demo-trader',
      tenantId,
      email: 'trader@apex.v12',
      name: 'Hermes Desk Operator',
      passwordHash: bcrypt.hashSync(password, 10),
      role: 'Arbitrage Trader',
      createdAt: now,
    },
  ];

  await store.bootstrap.importUsers(demo);
  console.warn('[store] Demo accounts seeded. Do not enable ENABLE_DEMO_USERS in production.');
}

export async function initialiseStore(store: Store): Promise<{ store: Store; defaultTenant: Tenant }> {
  /*
   * Definitionally unscoped work, so it says so.
   *
   * Creating the schema and creating the FIRST tenant cannot run under a tenant
   * scope: there is no tenant to scope to until they finish. Marking it here
   * rather than at each caller means the server, every CLI script, and anything
   * written later all get it right by default — which matters, because the
   * symptom of getting it wrong under RLS is `new row violates row-level
   * security policy` from a script that used to work.
   *
   * This is a bypass. What bounds it is that it takes no user input and nothing
   * reachable from a request calls it.
   */
  return runAsSystem('initialiseStore: schema and default tenant', () => initialiseStoreUnscoped(store));
}

async function initialiseStoreUnscoped(store: Store): Promise<{ store: Store; defaultTenant: Tenant }> {
  await store.init();

  // The default tenant is where a single-tenant deployment — the self-hosted
  // and desktop editions — spends its entire life. Multi-tenancy costs those
  // deployments one extra column and nothing else.
  let defaultTenant = await store.tenants.get(DEFAULT_TENANT_ID);

  if (!defaultTenant) {
    const plan = (process.env.DEFAULT_TENANT_PLAN as TenantPlan) ?? 'enterprise';
    const defaults = PLAN_DEFAULTS[plan] ?? PLAN_DEFAULTS.enterprise;

    defaultTenant = {
      id: DEFAULT_TENANT_ID,
      slug: DEFAULT_TENANT_SLUG,
      name: process.env.DEFAULT_TENANT_NAME || 'Default Organisation',
      plan: plan in PLAN_DEFAULTS ? plan : 'enterprise',
      status: 'active',
      seatLimit: defaults.seatLimit,
      monthlyAiCreditCents: defaults.monthlyAiCreditCents,
      assetLedgerEnabled: defaults.assetLedgerEnabled,
      createdAt: new Date().toISOString(),
    };
    await store.tenants.create(defaultTenant);
  }

  if (await store.bootstrap.isEmpty(defaultTenant.id)) {
    const imported = await importLegacyJson(store, defaultTenant.id);
    if (!imported) await store.bootstrap.seed(defaultTenant.id, seedNodes(), seedAssets());
  }

  await seedDemoUsers(store, defaultTenant.id);
  return { store, defaultTenant };
}
