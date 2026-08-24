/**
 * Launch pre-flight check.
 *
 * Run against a deployment BEFORE letting anyone near it. Every check here
 * corresponds to something that would be embarrassing, expensive, or
 * disclosable in production — not style opinions.
 *
 * Exit codes: 0 clean, 1 blockers found, 2 could not reach the deployment.
 *
 * Usage: npm run preflight https://your-deployment
 */

const BASE = process.argv[2] || process.env.PREFLIGHT_URL || 'http://localhost:3000';

type Severity = 'blocker' | 'warning' | 'info';

interface Finding {
  severity: Severity;
  name: string;
  detail: string;
}

const findings: Finding[] = [];
const passes: string[] = [];

const fail = (severity: Severity, name: string, detail: string) => findings.push({ severity, name, detail });
const pass = (name: string) => passes.push(name);

async function main() {
  console.log(`Pre-flight: ${BASE}\n`);

  // ------------------------------------------------------------------ reachable
  let health: any;
  try {
    const res = await fetch(`${BASE}/api/health`);
    health = await res.json();
  } catch (err) {
    console.error(`Cannot reach ${BASE}/api/health — ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }

  console.log(
    `  storage=${health.storage} tenants=${health.tenants} status=${health.status} ` +
      `marketplaces=${(health.execution?.marketplaces ?? []).join(',') || 'none'}\n`,
  );

  // ------------------------------------------------------- V12-CONST-001
  // The Constitution is the highest authority in the ecosystem (Article I
  // §1.1), so its absence is not a missing feature — it is a deployment that
  // is not governed.
  const constitution = health.constitution;
  if (!constitution?.instrument) {
    fail(
      'blocker',
      'No Constitution loaded',
      'V12-CONST-001 did not report at /api/health. An ungoverned deployment must not receive users.',
    );
  } else {
    pass(`${constitution.instrument} v${constitution.ratification} loaded and anchored (${String(constitution.digest).slice(0, 12)}…)`);

    if (constitution.ecosystemHalted) {
      fail('blocker', 'Ecosystem is HALTED', 'A catastrophic violation has halted execution. Human restart only (Article XI §11.1).');
    }

    // Article XIII §13.3(7): deploying to a production posture is itself a
    // release. Below quorum the Inspectorate issues nothing (§13.4), so this
    // deployment cannot lawfully have been certified.
    if (!constitution.inspectorate?.quorum) {
      fail(
        'blocker',
        `Inspectorate below quorum — ${constitution.inspectorate?.seated ?? 0} of ${constitution.inspectorate?.required ?? 3} seated`,
        'A production deployment is a release under Article XIII §13.3(7) and requires a Certificate of Release. ' +
          'Below quorum the Inspectorate issues nothing, so no certificate for this deployment can exist. ' +
          'Seat three Inspector Generals: npm run constitution:seat',
      );
    } else {
      pass(`Inspectorate seated ${constitution.inspectorate.seated}/${constitution.inspectorate.required} — quorum held`);
    }
  }

  // Article II §2.1 — the engine refuses to boot production on SQLite, so
  // seeing it here means this deployment is not in a production posture.
  if (health.storage !== 'postgres') {
    fail(
      'warning',
      `Storage is ${health.storage}, not Postgres`,
      'Article II §2.1 requires row-level security. The engine refuses a production posture on this backend, ' +
        'so this process is running as development.',
    );
  }

  // ------------------------------------------------------------------ TLS
  if (BASE.startsWith('https://')) {
    pass('Served over HTTPS');
  } else if (BASE.includes('localhost') || BASE.includes('127.0.0.1')) {
    fail('info', 'Not HTTPS', 'local deployment, expected');
  } else {
    // Session cookies are set `secure` in production, so over plain HTTP the
    // browser silently discards them and nobody can stay signed in.
    fail('blocker', 'Not served over HTTPS', 'secure cookies require TLS; sign-in will silently fail');
  }

  // ------------------------------------------------------------------ demo accounts
  // The single most common way a demo becomes a breach. Checked two ways: the
  // flag itself, and the documented default password. Testing only the password
  // gives a false pass whenever DEMO_PASSWORD was overridden — the accounts
  // still exist, they just have a different key.
  if (health.demoUsersEnabled) {
    fail(
      'blocker',
      'Demo accounts are seeded',
      'ENABLE_DEMO_USERS=true in production — these accounts ship with a known default password',
    );
  } else {
    pass('Demo account seeding is disabled');
  }

  const demoLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alex.atlas@apex.v12', password: 'macaron2026' }),
  });
  if (demoLogin.ok) {
    fail('blocker', 'The default demo password works', 'anyone with the source can sign in');
  } else {
    pass('Default demo credentials are rejected');
  }

  // ------------------------------------------------------------------ audit chain
  if (health.auditChain?.ok) {
    pass(`Audit chain intact across ${health.auditChain.tenants} tenant(s)`);
  } else {
    fail('blocker', 'Audit chain broken', `tenants affected: ${(health.auditChain?.broken ?? []).join(', ')}`);
  }

  // ------------------------------------------------------------------ storage
  if (health.storage === 'sqlite') {
    fail(
      'warning',
      'Running on SQLite',
      'fine for a single node or desktop; use Postgres if you need backups, replication, or more than one instance',
    );
  } else {
    pass('Running on Postgres');
  }

  // ------------------------------------------------------------------ marketplace
  //
  // This check was previously wrong in a way that narrowed the product. It
  // blocked ANY marketplace that was not 'internal', on the reasoning that a
  // deleted crypto-exchange adapter meant Apex had no external market at all.
  // It does have one: a multi-party market where distinct companies trade goods,
  // services and resources with each other.
  //
  // What must never arrive silently is a SECURITIES or CRYPTO venue — a
  // different thing entirely, and the thing the deletion was actually about. So
  // the check now names the excluded class rather than allow-listing one word.
  const marketplaces: string[] = health.execution?.marketplaces ?? [];
  const EXCLUDED = [
    'revolut', 'binance', 'coinbase', 'kraken', 'alpaca', 'ibkr', 'interactive-brokers',
    'exchange', 'brokerage', 'securities', 'equities', 'derivatives', 'futures', 'forex',
  ];
  const financial = marketplaces.filter((m) => EXCLUDED.some((x) => m.toLowerCase().includes(x)));

  if (financial.length > 0) {
    fail(
      'blocker',
      'A financial-instruments venue adapter is active',
      `${financial.join(', ')} — Apex trades goods, services and resources between companies. It is not a ` +
        'securities or crypto broker, and a venue adapter is a product decision that must not arrive in a deploy.',
    );
  } else if (marketplaces.length === 0) {
    fail('warning', 'No marketplace is active', 'nothing can be traded until one is running');
  } else {
    pass(`Trading in: ${marketplaces.join(', ')} — no financial-instruments venue present`);
  }

  if (health.execution?.discrepancies > 0) {
    fail(
      'blocker',
      'Ledger disagrees with the marketplace',
      `${health.execution.discrepancies} unresolved discrepancy(ies)`,
    );
  }

  // ------------------------------------------------------------------ beta gate
  // An open free signup on a deployment holding a real model API key is the
  // most expensive mistake available here, and it is invisible from outside
  // without this. Checked as a pair: the gate, and the cap behind it.
  const beta = health.beta ?? {};
  const multiTenant = health.multiTenant === true;

  if (multiTenant && !beta.inviteOnly) {
    fail(
      'warning',
      'Signup is open to anyone',
      'MULTI_TENANT=true without INVITE_ONLY=true — for a closed beta set INVITE_ONLY=true and mint codes with `npm run invite`',
    );
  } else if (beta.inviteOnly) {
    pass(`Registration is invite-only (${beta.redeemableInvites ?? 0} code(s) redeemable)`);
  }

  if (multiTenant && beta.inviteOnly && (beta.redeemableInvites ?? 0) === 0) {
    fail('info', 'No redeemable invites', 'nobody can sign up until you mint some');
  }

  if (multiTenant && !beta.maxTenants) {
    fail(
      'warning',
      'No population cap',
      'BETA_MAX_TENANTS is unset, so over-issuing invites has no backstop',
    );
  } else if (beta.maxTenants) {
    pass(`Population capped at ${beta.maxTenants} tenant(s), ${beta.headroom} remaining`);
  }

  // ------------------------------------------------------------------ admin API
  // The invite-minting API prints credentials. Its presence is a deliberate
  // choice, so a deployment that has it enabled should know, and one that has
  // it exposed without an IP pin should be told.
  const adminProbe = await fetch(`${BASE}/api/admin/invites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 1 }),
  });
  if (adminProbe.status === 404) {
    pass('Invite-minting API refuses unauthenticated callers with a bare 404');
  } else {
    fail(
      'blocker',
      'The invite-minting API answered an unauthenticated request',
      `status ${adminProbe.status} — anyone reaching it can print themselves accounts`,
    );
  }

  // ------------------------------------------------------- external API (/api/v1)
  // The one surface deliberately pointed at strangers. Three questions, and all
  // three have been the cause of somebody's incident: does it answer without a
  // key, does the public metadata route say anything about this deployment, and
  // does a rejection distinguish an unknown key from a wrong secret.
  try {
    const externalProbe = await fetch(`${BASE}/api/v1/inventory`);
    if (externalProbe.status === 401) {
      pass('External API refuses unauthenticated callers');
    } else {
      fail(
        'blocker',
        `The external API answered an unauthenticated request with ${externalProbe.status}`,
        'Every /api/v1 route below the metadata endpoint requires a scoped key',
      );
    }

    const metaProbe = await fetch(`${BASE}/api/v1`);
    const metaBody = (await metaProbe.json()) as { data?: Record<string, unknown> };
    const fields = Object.keys(metaBody.data ?? {}).sort().join(',');
    if (fields === 'api,authentication,documentation,scopes,service') {
      pass('External API metadata is public and describes only the protocol');
    } else {
      fail(
        'warning',
        'The public API metadata route has grown fields',
        `now returns: ${fields} — an unauthenticated caller should learn how to talk to the API and nothing about this deployment`,
      );
    }

    // Two failures that must be indistinguishable: a key id that does not exist,
    // and a real-looking id with the wrong secret. A different message for each
    // is an oracle for enumerating issued keys.
    const [unknownKey, badSecret] = await Promise.all([
      fetch(`${BASE}/api/v1/inventory`, { headers: { authorization: 'Bearer apex_aaaaaaaaaaaa_bbbbbbbb' } }),
      fetch(`${BASE}/api/v1/inventory`, { headers: { authorization: `Bearer apex_zzzzzzzzzzzz_${'y'.repeat(40)}` } }),
    ]);
    const [a, b] = await Promise.all([unknownKey.text(), badSecret.text()]);
    const strip = (body: string) => body.replace(/"requestId":"[^"]*"/, '').replace(/"at":"[^"]*"/, '');
    if (unknownKey.status === badSecret.status && strip(a) === strip(b)) {
      pass('Unknown keys and wrong secrets are indistinguishable to a caller');
    } else {
      fail(
        'blocker',
        'The external API distinguishes an unknown key from a wrong secret',
        'That difference lets an attacker enumerate which key ids have been issued',
      );
    }
  } catch (err) {
    fail('warning', 'Could not probe the external API', err instanceof Error ? err.message : String(err));
  }

  // ------------------------------------------------------------------ metering
  if (health.geminiConfigured && !beta.meteringConfigured) {
    fail(
      'blocker',
      'Inference is billable but token prices are not configured',
      'AI_INPUT_CENTS_PER_MTOK / AI_OUTPUT_CENTS_PER_MTOK are unset, so spend is estimated against placeholder rates — set them from your provider price list',
    );
  } else if (beta.meteringConfigured) {
    pass('Inference metering is configured and enforced per tenant');
  } else {
    pass('Inference metering active (no API key configured, so nothing is billable)');
  }

  // ------------------------------------------------------------------ the twin
  // The vault drives the risk layer now. A dangling link or an unparseable
  // frontmatter block is not a cosmetic problem — it is a production line the
  // breaker can no longer see.
  try {
    const twin = await fetch(`${BASE}/api/twin/graph`).then((r) => r.json());
    const errors = twin.valuation?.errors ?? 0;
    const warnings = twin.valuation?.warnings ?? 0;

    if (errors > 0) {
      const first = (twin.issues ?? []).find((i: any) => i.severity === 'error');
      fail(
        'blocker',
        'The digital twin has structural errors',
        `${errors} error(s), first: ${first?.slug} — ${first?.message}`,
      );
    } else if (warnings > 0) {
      fail('warning', 'The digital twin has warnings', `${warnings} — see /api/twin/graph`);
    } else {
      pass('Digital twin parses cleanly with no dangling references');
    }
  } catch (err) {
    fail('blocker', 'Cannot derive the digital twin', err instanceof Error ? err.message : String(err));
  }

  // ------------------------------------------------------------------ headers
  const root = await fetch(BASE);
  const csp = root.headers.get('content-security-policy') ?? '';
  const hsts = root.headers.get('strict-transport-security');

  if (!csp) {
    fail('blocker', 'No Content-Security-Policy header', 'helmet is not applying');
  } else if (csp.includes('unsafe-eval')) {
    fail(
      'blocker',
      "CSP allows 'unsafe-eval'",
      'that is the development policy — NODE_ENV is not set to production',
    );
  } else {
    pass("CSP present and forbids 'unsafe-eval'");
  }

  if (BASE.startsWith('https://') && !hsts) {
    fail('warning', 'No Strict-Transport-Security header', 'set it at your TLS terminator');
  }

  // The sandbox must keep its own, stricter policy.
  const sandboxCsp = (await fetch(`${BASE}/repl-sandbox`)).headers.get('content-security-policy') ?? '';
  if (sandboxCsp.includes("connect-src 'none'")) {
    pass('REPL sandbox blocks all network egress');
  } else {
    fail('blocker', 'REPL sandbox CSP is missing or weakened', 'generated code could reach the network');
  }

  // ------------------------------------------------------------------ indexing
  const robots = await fetch(`${BASE}/robots.txt`).then((r) => r.text());
  if (robots.includes('Disallow: /')) {
    pass('Crawlers disallowed on the application host');
  } else {
    fail('warning', 'robots.txt does not disallow crawling', 'app hosts should not be indexed');
  }

  // ------------------------------------------------------------------ auth gates
  const unauth = await fetch(`${BASE}/api/gemini/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'probe' }),
  });
  if (unauth.status === 401) {
    pass('Model endpoints require authentication');
  } else {
    fail('blocker', 'Model endpoints are reachable unauthenticated', `status ${unauth.status} — this spends your API budget`);
  }

  const unauthTrade = await fetch(`${BASE}/api/execution/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetId: 'X', side: 'buy', quantity: 1, type: 'market' }),
  });
  if (unauthTrade.status === 401) {
    pass('Asset instructions require authentication');
  } else {
    fail('blocker', 'Asset instructions reachable unauthenticated', `status ${unauthTrade.status}`);
  }

  // ------------------------------------------------------------------ commercial readiness
  // Not security, but the difference between "deployed" and "a business".
  fail('warning', 'No billing integration', 'seats and entitlements are enforced, but nothing takes payment');
  fail(
    'warning',
    'Rate limits and kill switch are per-process',
    'correct on a single instance, which is the closed-beta shape; move both to Redis BEFORE running a second one',
  );

  // ------------------------------------------------------------------ report
  const blockers = findings.filter((f) => f.severity === 'blocker');
  const warnings = findings.filter((f) => f.severity === 'warning');

  for (const p of passes) console.log(`PASS     ${p}`);
  console.log('');
  for (const f of warnings) console.log(`WARN     ${f.name} — ${f.detail}`);
  for (const f of blockers) console.log(`BLOCKER  ${f.name} — ${f.detail}`);

  console.log(
    `\n${passes.length} passed · ${warnings.length} warning(s) · ${blockers.length} blocker(s)`,
  );

  if (blockers.length > 0) {
    console.log('\nDo not put users on this until the blockers are cleared.');
    process.exit(1);
  }

  console.log('\nNo blockers. Warnings above are business readiness, not safety —');
  console.log('a free or invite-only launch can proceed; charging money still needs billing.');
}

main().catch((err) => {
  console.error('Pre-flight failed:', err instanceof Error ? err.message : err);
  process.exit(2);
});
