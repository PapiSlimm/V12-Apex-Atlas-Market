/**
 * The external API — the surface a stranger can reach.
 *
 * The tests that matter here are not "does it return inventory". They are the
 * ways a read-only integration API becomes an incident:
 *
 *   1. An error message that lets an attacker enumerate issued keys.
 *   2. A scope that quietly implies another.
 *   3. A revocation that takes effect "shortly".
 *   4. An integration that answers while the estate is halted.
 *   5. A response carrying another tenant's rows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { SqliteStore } from '../server/store/sqlite';
import { DEFAULT_TENANT_ID } from '../server/store/tenancy';
import { createExternalRouter, EXTERNAL_ROUTES, type Envelope } from '../server/external/router';
import { issueKey, type Scope } from '../server/external/keys';
import { marketRlsSql, RLS_SETTING, RLS_TABLES } from '../server/store/market-schema';

function fakeReq(over: Record<string, unknown> = {}) {
  const headers: Record<string, string> = (over.headers as Record<string, string>) ?? {};
  return {
    headers,
    query: {},
    params: {},
    body: {},
    path: '/api/v1/inventory',
    ip: '1.2.3.4',
    header: (name: string) => headers[name.toLowerCase()],
    ...over,
  } as never;
}

function fakeRes() {
  const state: { status: number; body: any; headers: Record<string, string> } = {
    status: 200,
    body: null,
    headers: {},
  };
  const res: any = {
    locals: {},
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      state.headers[name] = value;
    },
  };
  return { res: res as never, state };
}

async function freshStore(): Promise<SqliteStore> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-external-'));
  const store = new SqliteStore(path.join(dir, 'test.db'));
  await store.init();
  return store;
}

interface Harness {
  store: SqliteStore;
  router: ReturnType<typeof createExternalRouter>;
  halted: { value: boolean };
  audited: { event: string; outcome: string }[];
}

async function harness(over: { inventory?: (tenantId: string) => Promise<unknown> } = {}): Promise<Harness> {
  const store = await freshStore();
  const halted = { value: false };
  const audited: { event: string; outcome: string }[] = [];

  const router = createExternalRouter({
    lookupKey: (keyId) => store.externalKeys.get(keyId),
    audit: (e) => void audited.push({ event: e.event, outcome: e.outcome }),
    constitutionalGate: () =>
      halted.value
        ? { permitted: false, reason: 'A human halt is in force under Article X §10.2.' }
        : { permitted: true },
    inventory: over.inventory ?? (async (tenantId) => [{ tenantId, assetId: 'a-1' }]),
    twin: async () => ({ hubs: [] }),
    valuation: async () => ({ valuation: {} }),
    auditTrail: async (_t, limit) => ({ limit }),
  });

  return { store, router, halted, audited };
}

async function issue(store: SqliteStore, scopes: Scope[], tenantId: string = DEFAULT_TENANT_ID): Promise<string> {
  const issued = issueKey({ tenantId, label: 'Partner ERP', scopes });
  await store.externalKeys.save(issued.record);
  return issued.plaintext;
}

const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

/** Run the authenticate middleware and then the handler, the way express would. */
async function call(
  h: Harness,
  scopes: Scope[],
  handler: (req: never, res: never, next: never) => void,
  req: Record<string, unknown>,
) {
  const { res, state } = fakeRes();
  let reached = false;
  const next = () => {
    reached = true;
  };
  const request = fakeReq(req);
  await (h.router.authenticate(scopes) as unknown as (r: never, s: never, n: never) => Promise<void>)(
    request,
    res,
    next as never,
  );
  if (reached) await new Promise<void>((resolve) => handler(request, res, ((() => resolve()) as never)) ?? resolve());
  return { state, reached };
}

/* ---------------------------------------------------------------- *
 * Authentication
 * ---------------------------------------------------------------- */

test('a valid key reaches the handler and gets the standard envelope', async () => {
  const h = await harness();
  const token = await issue(h.store, ['inventory:read']);

  const { state, reached } = await call(h, ['inventory:read'], h.router.inventory, auth(token));
  assert.equal(reached, true);

  const body = state.body as Envelope<unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.meta.version, 'v1');
  assert.ok(body.meta.requestId);
  await h.store.close();
});

test('an unknown key and a wrong secret are indistinguishable', async () => {
  const h = await harness();
  const real = await issue(h.store, ['inventory:read']);
  const keyId = real.split('_')[1];

  const unknown = await call(h, ['inventory:read'], h.router.inventory, auth('apex_aaaaaaaaaaaa_bbbb'));
  const wrongSecret = await call(h, ['inventory:read'], h.router.inventory, auth(`apex_${keyId}_${'z'.repeat(40)}`));

  assert.equal(unknown.state.status, 401);
  assert.equal(wrongSecret.state.status, 401);
  assert.deepEqual(
    (unknown.state.body as Envelope<unknown>).error,
    (wrongSecret.state.body as Envelope<unknown>).error,
    'a different message here is an oracle for enumerating issued keys',
  );
  await h.store.close();
});

test('insufficient scope IS distinguished, and says which scope is needed', async () => {
  const h = await harness();
  const token = await issue(h.store, ['twin:read']);

  const { state, reached } = await call(h, ['inventory:read'], h.router.inventory, auth(token));
  assert.equal(reached, false);
  assert.equal(state.status, 403);
  const body = state.body as Envelope<unknown>;
  assert.equal(body.error?.code, 'insufficient_scope');
  assert.match(body.error!.message, /inventory:read/);
  await h.store.close();
});

test('revocation takes effect on the very next request', async () => {
  const h = await harness();
  const token = await issue(h.store, ['inventory:read']);
  const keyId = token.split('_')[1];

  assert.equal((await call(h, ['inventory:read'], h.router.inventory, auth(token))).state.status, 200);

  await h.store.externalKeys.revoke(keyId, Date.now());

  const after = await call(h, ['inventory:read'], h.router.inventory, auth(token));
  assert.equal(after.reached, false);
  assert.equal(after.state.status, 401, 'not "shortly" — the lookup is storage, not a cache');
  await h.store.close();
});

/* ---------------------------------------------------------------- *
 * The constitutional gate
 * ---------------------------------------------------------------- */

test('a halted estate answers nothing, however valid the key', async () => {
  const h = await harness();
  const token = await issue(h.store, ['inventory:read']);
  h.halted.value = true;

  const { state, reached } = await call(h, ['inventory:read'], h.router.inventory, auth(token));
  assert.equal(reached, false);
  assert.equal(state.status, 451, 'unavailable for legal reasons — the honest status for this');
  assert.match((state.body as Envelope<unknown>).error!.message, /Article X §10.2/);
  assert.ok(h.audited.some((a) => a.event === 'external.constitutionally_refused'));
  await h.store.close();
});

/* ---------------------------------------------------------------- *
 * Tenancy
 * ---------------------------------------------------------------- */

test('a key can only ever read its own tenant', async () => {
  const seen: string[] = [];
  const h = await harness({
    inventory: async (tenantId) => {
      seen.push(tenantId);
      return [];
    },
  });
  const token = await issue(h.store, ['inventory:read'], 'tenant-b');

  await call(h, ['inventory:read'], h.router.inventory, auth(token));
  assert.deepEqual(seen, ['tenant-b'], 'the tenant comes from the KEY, never from the request');
  await h.store.close();
});

test('the audit limit is bounded server-side', async () => {
  const h = await harness();
  const token = await issue(h.store, ['audit:read']);

  const huge = await call(h, ['audit:read'], h.router.auditTrail, {
    ...auth(token),
    path: '/api/v1/audit',
    query: { limit: '1000000' },
  });
  assert.equal(((huge.state.body as Envelope<{ limit: number }>).data)!.limit, 500);

  const nonsense = await call(h, ['audit:read'], h.router.auditTrail, {
    ...auth(token),
    path: '/api/v1/audit',
    query: { limit: 'banana' },
  });
  assert.equal(((nonsense.state.body as Envelope<{ limit: number }>).data)!.limit, 100);
  await h.store.close();
});

/* ---------------------------------------------------------------- *
 * The surface itself
 * ---------------------------------------------------------------- */

test('metadata is public and says nothing about the estate', async () => {
  const h = await harness();
  const { res, state } = fakeRes();
  h.router.meta(fakeReq(), res);

  const data = (state.body as Envelope<Record<string, unknown>>).data!;
  assert.equal(data.api, 'v1');

  // An exact field set rather than a substring scan. The point of this route is
  // that an unauthenticated caller learns how to talk to the API and NOTHING
  // about this deployment — no tenant count, no key count, no estate topology.
  // A new field appearing here should be a decision somebody made, so the test
  // fails when one does.
  assert.deepEqual(
    Object.keys(data).sort(),
    ['api', 'authentication', 'documentation', 'scopes', 'service'],
    'a new field on the public metadata route needs a deliberate look',
  );
  // The word "secret" appears in the auth FORMAT string, which is documentation,
  // not disclosure. What must not appear is a value.
  assert.match(String(data.authentication), /apex_<keyId>_<secret>/);
  await h.store.close();
});

test('every declared route is read-only', () => {
  for (const route of EXTERNAL_ROUTES) {
    assert.equal(route.method, 'GET', `${route.path} is ${route.method} — there is no external write path`);
  }
});

/* ---------------------------------------------------------------- *
 * Row-level security
 * ---------------------------------------------------------------- */

test('RLS covers every tenant-scoped table, including the market ones', () => {
  for (const table of ['users', 'audit_log', 'market_inventory', 'market_listings', 'market_corrections']) {
    assert.ok(RLS_TABLES.includes(table as never), `${table} is not covered by RLS`);
  }
});

test('external_keys is deliberately outside tenant RLS, and that is the only exception', () => {
  // A presented key is looked up by its public handle BEFORE any tenant is
  // known — that lookup is what establishes the tenant. A tenant policy here
  // would require knowing the answer to ask the question, and both ways out are
  // worse: a system-scope bypass on the hottest auth path, or a cache that
  // makes revocation take effect "shortly".
  assert.equal(RLS_TABLES.includes('external_keys' as never), false);

  // Isolation for this table is the hash. The row carries a key id, a hash, a
  // label and a scope list — no customer data — and possession of the secret is
  // the only thing that makes it useful.
  const covered = new Set<string>(RLS_TABLES);
  for (const table of ['users', 'assets', 'trades', 'orders', 'fills', 'meta', 'ai_usage', 'twin_nodes']) {
    assert.ok(covered.has(table), `${table} carries customer data and must be covered`);
  }
});

test('the system scope is a separate setting, not a magic tenant id', () => {
  const policy = marketRlsSql(['users']).find((s) => s.includes('CREATE POLICY'))!;
  assert.match(policy, /current_setting\('apex\.system', true\) = 'on'/);
  assert.notEqual(
    RLS_SETTING,
    'apex.system',
    'a sentinel tenant value could be passed as a tenant id; a separate setting cannot',
  );
});

test('RLS is FORCED, or the owner bypasses it and it is decoration', () => {
  const sql = marketRlsSql(['users']);
  assert.ok(sql.some((s) => /ENABLE ROW LEVEL SECURITY/.test(s)));
  assert.ok(
    sql.some((s) => /FORCE ROW LEVEL SECURITY/.test(s)),
    'the application usually connects as the table owner, who bypasses unFORCEd policies',
  );
});

test('the RLS policy constrains both reads and writes', () => {
  const policy = marketRlsSql(['users']).find((s) => s.includes('CREATE POLICY'))!;
  assert.match(policy, /USING \(tenant_id = current_setting/, 'reads');
  assert.match(policy, /WITH CHECK \(tenant_id = current_setting/, 'writes — otherwise a tenant can insert into another');
  assert.ok(policy.includes(RLS_SETTING));
});

test('a missing tenant setting yields nothing rather than everything', () => {
  const policy = marketRlsSql(['users']).find((s) => s.includes('CREATE POLICY'))!;
  // The `true` second argument makes current_setting return '' instead of
  // raising when unset. '' matches no tenant_id, so the failure mode is an
  // empty result — which is the direction a failure should fall.
  assert.match(policy, new RegExp(`current_setting\\('${RLS_SETTING.replace('.', '\\.')}', true\\)`));
});
