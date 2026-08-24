/**
 * Multi-tenant isolation probe, over HTTP.
 *
 * The store-level isolation tests prove the queries are scoped. This proves the
 * *routes* are, which is a different question and the one that actually leaks.
 * Both bugs found during the tenancy work were route-level, not store-level:
 *
 *   1. A signup with no organisation fell through into the shared default
 *      tenant — putting a stranger inside the operator's own book.
 *   2. Public routes resolved the tenant from `req.user`, but had no auth
 *      middleware, so `req.user` was always undefined. A signed-in customer
 *      was served the default organisation's positions and vault.
 *
 * Neither would have been caught by a store test. Hence this.
 *
 * Usage: npm run verify:tenancy [baseUrl]
 */

const BASE = process.argv[2] || 'http://localhost:3000';

interface Session {
  cookies: string;
  csrf: string;
  tenantId: string;
  label: string;
}

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function parseCookies(res: Response): { cookies: string; csrf: string } {
  const raw = res.headers.getSetCookie?.() ?? [];
  const jar: Record<string, string> = {};
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return {
    cookies: Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; '),
    csrf: decodeURIComponent(jar.apex_csrf ?? ''),
  };
}

async function register(label: string, organisation: string | null, plan: string): Promise<Session> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const body: Record<string, unknown> = {
    email: `${label.toLowerCase()}-${suffix}@probe.test`,
    password: 'ProbePassword12345',
    name: label,
    role: 'Executive',
    plan,
  };
  if (organisation) body.organisation = organisation;

  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`register ${label} failed: ${res.status} ${await res.text()}`);
  const { cookies, csrf } = parseCookies(res);
  const data = (await res.json()) as { user: { tenantId: string } };
  return { cookies, csrf, tenantId: data.user.tenantId, label };
}

const authed = (s: Session, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: {
    ...(init.headers ?? {}),
    Cookie: s.cookies,
    'X-CSRF-Token': s.csrf,
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
  },
});

async function main() {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  console.log(`Probing ${BASE} — storage ${health.storage}, ${health.tenants} tenant(s)\n`);

  const a = await register('Acme', 'Acme Corp', 'business');
  const b = await register('Globex', 'Globex Ltd', 'business');

  check('Two signups get two different tenants', a.tenantId !== b.tenantId, `${a.tenantId.slice(0, 12)} vs ${b.tenantId.slice(0, 12)}`);

  // --- the fall-through bug -------------------------------------------------
  const solo = await register('Solo', null, 'explorer');
  check(
    'Signup without an organisation does NOT join the default tenant',
    solo.tenantId !== 'tnt-default',
    solo.tenantId.slice(0, 16),
  );

  // --- vault isolation ------------------------------------------------------
  const secret = `ACME-SECRET-${Math.random().toString(36).slice(2, 8)}`;
  const edit = await fetch(
    `${BASE}/api/vault/node`,
    authed(a, { method: 'PUT', body: JSON.stringify({ id: 'node-detroit', content: secret }) }),
  );
  check('Tenant A can edit its own vault', edit.ok, `status ${edit.status}`);

  const bNodes = (await fetch(`${BASE}/api/vault/nodes`, authed(b)).then((r) => r.json())) as {
    nodes: { content: string }[];
  };
  check(
    "Tenant B cannot read tenant A's vault content",
    !bNodes.nodes.some((n) => n.content.includes(secret)),
  );

  // --- the optionalAuth bug -------------------------------------------------
  const aNodes = (await fetch(`${BASE}/api/vault/nodes`, authed(a)).then((r) => r.json())) as {
    nodes: { content: string }[];
  };
  check(
    'A signed-in user reads their OWN vault on a public route',
    aNodes.nodes.some((n) => n.content.includes(secret)),
    'this failed before optionalAuth existed',
  );

  const aState = (await fetch(`${BASE}/api/execution/state`, authed(a)).then((r) => r.json())) as {
    tenant: { id: string; name: string } | null;
  };
  check(
    'A signed-in user sees their OWN organisation on the desk',
    aState.tenant?.id === a.tenantId,
    aState.tenant?.name ?? 'null',
  );

  const anonState = (await fetch(`${BASE}/api/execution/state`).then((r) => r.json())) as {
    tenant: { id: string } | null;
  };
  check(
    'A signed-out visitor still sees the default demo book',
    anonState.tenant?.id === 'tnt-default',
    anonState.tenant?.id ?? 'null',
  );

  // --- trade + audit isolation ---------------------------------------------
  const trade = await fetch(
    `${BASE}/api/hermes/trade`,
    authed(a, { method: 'POST', body: JSON.stringify({ asset_id: 'AST-H266-001' }) }),
  );
  check('Tenant A executes a trade', trade.ok, `status ${trade.status}`);

  const bTrades = (await fetch(`${BASE}/api/hermes/trades`, authed(b)).then((r) => r.json())) as {
    trades: unknown[];
  };
  check("Tenant B sees none of tenant A's trades", bTrades.trades.length === 0, `${bTrades.trades.length} visible`);

  const aAudit = (await fetch(`${BASE}/api/audit?limit=200`, authed(a)).then((r) => r.json())) as {
    entries: { event: string }[];
    chain: { ok: boolean; entries: number };
  };
  const bAudit = (await fetch(`${BASE}/api/audit?limit=200`, authed(b)).then((r) => r.json())) as {
    entries: { event: string }[];
    chain: { ok: boolean; entries: number };
  };

  check("Tenant A's audit records its trade", aAudit.entries.some((e) => e.event === 'trade.executed'));
  check(
    "Tenant B's audit contains none of tenant A's events",
    !bAudit.entries.some((e) => e.event === 'trade.executed'),
    `B has ${bAudit.entries.length} entries`,
  );
  check('Each tenant has an independently valid chain', aAudit.chain.ok && bAudit.chain.ok);
  check(
    "A new tenant's chain starts fresh rather than continuing a global counter",
    bAudit.chain.entries < aAudit.chain.entries,
    `A=${aAudit.chain.entries} B=${bAudit.chain.entries}`,
  );

  // --- plan entitlement -----------------------------------------------------
  // The free tier used to be REFUSED here, and so did the $49 tier. That gate
  // came from a pricing model built for a financial execution platform: a
  // paying customer was told their plan "does not include trade execution", a
  // capability this product does not have, and was locked out of its central
  // workflow. The ledger books a customer's own inventory; scale is gated by
  // seats and inference credit, which is where the cost actually is.
  const soloOrder = await fetch(
    `${BASE}/api/execution/order`,
    authed(solo, {
      method: 'POST',
      body: JSON.stringify({ assetId: 'AST-H266-001', side: 'buy', quantity: 1, type: 'market' }),
    }),
  );
  check(
    'The free tier can write to its own asset ledger',
    soloOrder.status === 201,
    `status ${soloOrder.status}`,
  );

  const aOrder = await fetch(
    `${BASE}/api/execution/order`,
    authed(a, {
      method: 'POST',
      body: JSON.stringify({ assetId: 'AST-H266-001', side: 'buy', quantity: 5, type: 'market' }),
    }),
  );
  check('A paid tier can write to its own asset ledger', aOrder.status === 201, `status ${aOrder.status}`);

  // The entitlement machinery itself must still work — it is the seam a future
  // read-only or suspended plan would use. Verified by asserting the tenant
  // record carries the flag rather than by removing a customer's access.
  const aTenant = (await fetch(`${BASE}/api/execution/state`, authed(a)).then((r) => r.json())) as {
    tenant?: { assetLedgerEnabled?: boolean; plan?: string };
  };
  check(
    'The ledger entitlement is carried on the tenant record',
    aTenant.tenant?.assetLedgerEnabled === true,
    `plan ${aTenant.tenant?.plan} entitled ${aTenant.tenant?.assetLedgerEnabled}`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Probe failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
