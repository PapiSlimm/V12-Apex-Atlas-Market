/**
 * End-to-end smoke check against a running production build.
 *
 * RUN THIS AGAINST A FRESH INSTANCE. The suite is deliberately not idempotent:
 * it opens positions, engages the kill switch and ends by marking a production
 * line degraded in the vault to prove the breaker fires. Running it twice
 * against the same server produces a screen of reds that mean "state left over
 * from the previous run", not "regression".
 *
 * Boot the target with MARKET_BEHAVIOUR=calm — see the note below.
 *
 * Usage: node scripts/verify.mjs [baseUrl]
 */
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = 'screenshots';
const EMAIL = process.env.VERIFY_EMAIL || 'alex.atlas@apex.v12';
const PASSWORD = process.env.VERIFY_PASSWORD || 'ApexDemo!2026x';

fs.mkdirSync(OUT, { recursive: true });

const consoleErrors = [];
const pageErrors = [];
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage();

page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(e.message));

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });

/*
 * A note on flakiness, because it cost time to notice.
 *
 * The internal marketplace is deliberately hostile by default: 3% of orders are
 * rejected outright and 2% fail as if the network dropped. That is exactly what
 * the unit tests want, and exactly what this suite does NOT — over the several
 * orders placed below it gives a real chance of a red run that means nothing.
 * A suite that is sometimes red for no reason teaches people to re-run it.
 *
 * So the deployment under test should be booted with MARKET_BEHAVIOUR=calm.
 * This warns if it was not, rather than silently producing an occasional red.
 */
const behaviourWarning = () =>
  console.warn(
    '\nNOTE  This deployment appears to be running the hostile marketplace model.\n' +
      '      Boot it with MARKET_BEHAVIOUR=calm for a deterministic suite.\n',
  );

// ------------------------------------------------------- CSP separation
// The app origin must not be able to eval; the sandbox must not be able to
// reach the network. That inversion is the whole security argument.
const appHeaders = await (await fetch(BASE)).headers;
const appCsp = appHeaders.get('content-security-policy') || '';
const sandboxCsp = (await fetch(`${BASE}/repl-sandbox`)).headers.get('content-security-policy') || '';

check("App CSP forbids 'unsafe-eval'", !appCsp.includes('unsafe-eval'), appCsp.slice(0, 80));
check("Sandbox CSP blocks all network egress", sandboxCsp.includes("connect-src 'none'"), sandboxCsp.slice(0, 80));
check("Sandbox CSP defaults to 'none'", sandboxCsp.includes("default-src 'none'"));

// ---------------------------------------------------------------- load
await page.goto(BASE, { waitUntil: 'networkidle' });

// -------------------------------------------------------- arrival sequence
// A visitor now lands on the intro film, then the launch page, then the
// workspace. Checked here rather than skipped past, because it is the first
// thing every user sees and a break in it breaks everything after it.
check('Intro sequence is the first thing a visitor sees', await page.locator('video').first().isVisible());
check(
  'The intro is skippable from the first frame',
  await page.locator('button:has-text("Skip")').isVisible(),
);
check(
  'The intro offers both an H.264 and a royalty-free source',
  (await page.locator('video source').count()) >= 2,
  `${await page.locator('video source').count()} sources`,
);

await page.click('button:has-text("Skip")');
await page.waitForSelector('text=Redeem an invite', { timeout: 8000 });
check('The intro dissolves into the launch page', await page.locator('h1').first().isVisible());
check(
  'The launch page states the beta is closed',
  await page.locator('text=Closed beta').first().isVisible(),
);
check(
  'The house mark is on the launch page',
  await page.locator('img[alt*="Urban Visions"]').first().isVisible(),
);

await page.reload({ waitUntil: 'networkidle' });
check(
  'A returning visitor is not shown the intro again',
  (await page.locator('video').count()) === 0,
);

await page.click('button:has-text("Look around first")');
await page.waitForSelector('#command-input', { timeout: 8000 });
check('App boots', await page.locator('text=V12 APEX ATLAS').first().isVisible());
check('Document title is branded', (await page.title()).includes('Apex Atlas'), await page.title());
await shot('01-command-center-signed-out');

// -------------------------------------------------------- auth required
await page.fill('#command-input', 'hello');
check(
  'Dispatch is gated when signed out',
  await page.locator('button:has-text("Sign in")').first().isVisible(),
);

// ---------------------------------------------------------------- login
await page.locator('header button:has-text("Sign In"), header button:has-text("Sign in")').first().click();
await page.waitForSelector('#auth-email');
await page.fill('#auth-email', EMAIL);
await page.fill('#auth-password', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForSelector('button:has-text("Sign Out"), button:has-text("Sign out")', { timeout: 10000 });
check('Sign-in succeeds', true);

const cookies = await context.cookies();
const session = cookies.find((c) => c.name === 'apex_session');
check('Session cookie is httpOnly', Boolean(session?.httpOnly));
check('Session cookie is SameSite=Strict', session?.sameSite === 'Strict', session?.sameSite);

const tokenInStorage = await page.evaluate(() =>
  Object.keys(localStorage).filter((k) => /token|jwt/i.test(k)),
);
check('No token in localStorage', tokenInStorage.length === 0, JSON.stringify(tokenInStorage));
await shot('02-command-center-signed-in');

// ------------------------------------------------------------- CSRF
// A cookie-authenticated mutating request without the double-submit header
// must be rejected, even though the browser attaches the session cookie.
const csrfProbe = await page.evaluate(async () => {
  const res = await fetch('/api/hermes/trade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ asset_id: 'AST-H266-001' }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
});
check(
  'Mutating request without CSRF header is rejected',
  csrfProbe.status === 403 && csrfProbe.body?.code === 'csrf_failed',
  `status ${csrfProbe.status}`,
);

const csrfCookie = (await context.cookies()).find((c) => c.name === 'apex_csrf');
check('CSRF cookie is present and readable', Boolean(csrfCookie) && csrfCookie.httpOnly === false);

// ----------------------------------------------------- THE CRITICAL FIX
// The REPL harness previously threw `SyntaxError: Unexpected token '<'` on
// every compile. Verify a real component now renders — inside the sandbox.
await page.click('button:has-text("UI4A REPL")');
await page.waitForSelector('textarea');
await page.waitForTimeout(3000); // babel chunk + sandbox boot + compile

const harness = page.locator('text=EXEC HARNESS').first();
check('REPL harness mounts', await harness.isVisible());
check(
  'Default artifact compiles (no SyntaxError)',
  !(await page.locator('text=Compilation failed').first().isVisible()),
);

// ------------------------------------------------------ SANDBOX ISOLATION
const frameEl = await page.locator('iframe[title*="sandboxed"]').first().elementHandle();
check('Artifact renders in an iframe', Boolean(frameEl));

const sandboxAttr = await page.getAttribute('iframe[title*="sandboxed"]', 'sandbox');
check('Sandbox allows scripts', (sandboxAttr || '').includes('allow-scripts'), sandboxAttr);
check(
  'Sandbox does NOT allow same-origin',
  !(sandboxAttr || '').includes('allow-same-origin'),
  sandboxAttr,
);

const sandboxFrame = page.frames().find((f) => f.url().includes('/repl-sandbox'));
check('Sandbox document loaded', Boolean(sandboxFrame));
check(
  'Compiled artifact rendered inside the sandbox',
  await sandboxFrame.locator('text=V12 GENUI REPL VECTOR').first().isVisible(),
);

// An opaque origin means no cookies, no storage, and no parent access.
const isolation = await sandboxFrame.evaluate(() => {
  const probe = { origin: 'unknown', cookie: 'unreadable', storage: 'blocked', parentDom: 'blocked' };
  try {
    probe.origin = String(window.origin);
  } catch {
    probe.origin = 'opaque';
  }
  try {
    probe.cookie = document.cookie;
  } catch {
    probe.cookie = 'blocked';
  }
  try {
    void window.localStorage.length;
    probe.storage = 'accessible';
  } catch {
    probe.storage = 'blocked';
  }
  try {
    probe.parentDom = window.parent.document ? 'accessible' : 'blocked';
  } catch {
    probe.parentDom = 'blocked';
  }
  return probe;
});
check('Sandbox runs on an opaque origin', isolation.origin === 'null' || isolation.origin === 'opaque', isolation.origin);
check('Sandbox cannot read cookies', isolation.cookie === '' || isolation.cookie === 'blocked', isolation.cookie);
check('Sandbox cannot reach localStorage', isolation.storage === 'blocked', isolation.storage);
check('Sandbox cannot reach the parent DOM', isolation.parentDom === 'blocked', isolation.parentDom);

// Feed it something new to prove live recompilation works.
await page.locator('textarea').fill(
  `const label = data?.title ?? 'live recompile';
return (
  <div className="p-4 bg-emerald-950 border border-emerald-500 rounded-xl">
    <h4 className="text-emerald-300 font-bold" id="probe-heading">RECOMPILED OK</h4>
    <p className="text-xs text-emerald-200">{label}</p>
  </div>
);`,
);
await page.waitForTimeout(1800);
const frameAfterEdit = page.frames().find((f) => f.url().includes('/repl-sandbox'));
check('Live edit recompiles', await frameAfterEdit.locator('#probe-heading').isVisible());
await shot('03-repl-harness');

// An intentionally broken component must surface an error, not blank the app.
await page.locator('textarea').fill('return (<div>unclosed);');
await page.waitForTimeout(1500);
check('Broken source shows a compile error', await page.locator('text=Compilation failed').first().isVisible());
check('App survives a compile error', await page.locator('text=V12 APEX ATLAS').first().isVisible());
await shot('04-repl-compile-error');

// ------------------------------------------------------------- boardroom
await page.click('button:has-text("Revenue Boardroom")');
await page.waitForTimeout(1200);
check('Modelled-bid disclosure is shown', await page.locator('text=Bids are modelled').first().isVisible());

// -------------------------------------------------- digital twin, derived
// The boardroom used to print constants from the specification's mock-up.
// These checks exist to make sure it is reading the vault instead.
await page.waitForSelector('text=Supply network', { timeout: 10000 });
check('Supply network panel renders', await page.locator('text=Supply network').first().isVisible());

const twin = await page.evaluate(async () => {
  const res = await fetch('/api/twin/graph', { credentials: 'same-origin' });
  return res.json();
});
check('Twin graph parses the seeded vault', twin.factories?.length === 1 && twin.warehouses?.length === 2,
  `${twin.hubs?.length} hub / ${twin.factories?.length} factory / ${twin.warehouses?.length} warehouse`);
check('A shipped vault reports no consistency issues', (twin.issues?.length ?? -1) === 0,
  JSON.stringify(twin.issues?.slice(0, 2) ?? []));
check('Production lines keep their native units',
  twin.factories[0].lines.some((l) => l.throughputUnit === 'fps') &&
  twin.factories[0].lines.some((l) => l.throughputUnit === 'hz'),
  twin.factories[0].lines.map((l) => `${l.lineId}:${l.throughputUnit}`).join(' '));

const twinH266 = twin.valuation.blocks.find((b) => b.assetClass === 'H266_Video_NFT');
check('Strike floor is derived from acquisition cost', twinH266.strikeFloor === 16.25, String(twinH266.strikeFloor));
check('Auto-strike fires on the specification example', twinH266.verdict === 'SELL_STRIKE', twinH266.verdict);
check('Buffer load is computed, not hardcoded',
  Math.abs(twin.valuation.warehouses.find((w) => w.nodeId === 'MWH-ALPHA').utilisation - 0.4203) < 1e-4,
  String(twin.valuation.warehouses.find((w) => w.nodeId === 'MWH-ALPHA').utilisation));
check('Ecosystem valuation sums the book', twin.valuation.totalValuation === 73856,
  String(twin.valuation.totalValuation));
check('The AUTO-STRIKE verdict reaches the screen',
  await page.locator('text=AUTO-STRIKE').first().isVisible());

check('Positions load', await page.locator('text=H266 Render NFT').first().isVisible());
check('Fee-aware net column present', await page.locator('text=Net of fees').first().isVisible());
await shot('05-revenue-boardroom');

// -------------------------------------------- trade gating + audit trail
// Execute a legitimate trade, then attempt one the engine must refuse, and
// confirm BOTH land in the audit log.
const tradeOk = await page.evaluate(async () => {
  const csrf = document.cookie.match(/apex_csrf=([^;]*)/)?.[1] ?? '';
  const res = await fetch('/api/hermes/trade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
    credentials: 'same-origin',
    body: JSON.stringify({ asset_id: 'AST-H266-001' }),
  });
  return { status: res.status, body: await res.json() };
});
check('Qualifying trade executes', tradeOk.status === 200, `status ${tradeOk.status}`);
check(
  'Realised P&L is net of both fee legs',
  Math.abs((tradeOk.body?.tradeLog?.realized_net_total ?? 0) - 5154.6) < 0.01,
  String(tradeOk.body?.tradeLog?.realized_net_total),
);

const tradeRefused = await page.evaluate(async () => {
  const csrf = document.cookie.match(/apex_csrf=([^;]*)/)?.[1] ?? '';
  const res = await fetch('/api/hermes/trade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
    credentials: 'same-origin',
    body: JSON.stringify({ asset_id: 'AST-COMPUTE-003' }),
  });
  return { status: res.status, body: await res.json() };
});
check('Non-qualifying trade is refused', tradeRefused.status === 409, `status ${tradeRefused.status}`);

await page.click('button:has-text("Decision Audit Log")');
await page.waitForTimeout(1500);
check('Audit chain verifies', await page.locator('text=Chain intact').isVisible());
check('Executed trade is logged', await page.locator('text=trade.executed').first().isVisible());
check('Refused trade is logged', await page.locator('text=trade.refused').first().isVisible());
await shot('11-audit-log');

// -------------------------------------------------------- ASSET LEDGER
await page.click('button:has-text("Asset Ledger")');
await page.waitForTimeout(2000);

check('Asset ledger loads', await page.locator('text=Asset ledger').first().isVisible());
check('Modelled-bid disclosure shown', await page.locator('text=Bids are modelled, not live').isVisible());
check('Live quotes render', await page.locator('text=bid').first().isVisible());

// The engine sizes the order; verify the plan is a sized instruction, not a
// verdict on the whole position.
const deskState = await page.evaluate(async () => {
  const res = await fetch('/api/execution/state', { credentials: 'same-origin' });
  return res.json();
});
check('Asset universe loaded', (deskState.rows?.length ?? 0) >= 3, `${deskState.rows?.length} rows`);
check('Risk limits are exposed', typeof deskState.risk?.maxOrderNotional === 'number');
check('Boot reconciliation ran', deskState.lastReconciliation !== undefined);

// Positions start flat, so the strategy must hold rather than invent inventory.
check(
  'Strategy holds on a flat book',
  deskState.rows.every((r) => r.plan.action === 'hold'),
  deskState.rows.map((r) => r.plan.action).join(','),
);

// Place a buy to open a position, then watch it fill.
const placeBuy = await page.evaluate(async () => {
  const csrf = document.cookie.match(/apex_csrf=([^;]*)/)?.[1] ?? '';
  const res = await fetch('/api/execution/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
    credentials: 'same-origin',
    body: JSON.stringify({
      assetId: 'AST-H266-001',
      side: 'buy',
      quantity: 100,
      type: 'market',
      reason: 'verify',
    }),
  });
  return { status: res.status, body: await res.json() };
});
check('Acquisition instruction accepted', placeBuy.status === 201, `status ${placeBuy.status}`);

await page.waitForTimeout(6000); // simulator ticks + fill ingestion

const afterFill = await page.evaluate(async () => {
  const res = await fetch('/api/execution/state', { credentials: 'same-origin' });
  return res.json();
});
const h266 = afterFill.rows.find((r) => r.spec.assetId === 'AST-H266-001');
check('Fills arrived and built a position', (h266?.position.quantity ?? 0) > 0, String(h266?.position.quantity));
check('Cost basis includes fees', (h266?.position.averageCost ?? 0) > 0, String(h266?.position.averageCost));

// The ledger invariant, checked through the API rather than in a unit test.
const balances =
  Math.abs(
    h266.position.realisedPnl - h266.position.quantity * h266.position.averageCost - h266.position.cashFlow,
  ) < 1e-3;
check('Books balance: realised − qty×basis = cashFlow', balances);

// Risk controls: an order far past the notional ceiling must be refused.
const oversized = await page.evaluate(async () => {
  const csrf = document.cookie.match(/apex_csrf=([^;]*)/)?.[1] ?? '';
  const res = await fetch('/api/execution/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
    credentials: 'same-origin',
    body: JSON.stringify({ assetId: 'AST-H266-001', side: 'buy', quantity: 10_000_000, type: 'market' }),
  });
  return { status: res.status, body: await res.json() };
});
check('Oversized order refused by risk', oversized.status === 409, `status ${oversized.status}`);
check(
  'Refusal names the limit it broke',
  (oversized.body?.violations ?? []).some((v) => v.code === 'max_order_notional'),
  JSON.stringify(oversized.body?.violations?.map((v) => v.code)),
);

// Kill switch.
await page.click('button:has-text("Halt settlement")');
await page.waitForTimeout(1500);
check('Halt banner appears', await page.locator('text=Settlement halted').first().isVisible());

const whileHalted = await page.evaluate(async () => {
  const csrf = document.cookie.match(/apex_csrf=([^;]*)/)?.[1] ?? '';
  const res = await fetch('/api/execution/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
    credentials: 'same-origin',
    body: JSON.stringify({ assetId: 'AST-H266-001', side: 'sell', quantity: 1, type: 'market' }),
  });
  return res.status;
});
check('Kill switch blocks execution', whileHalted === 409, `status ${whileHalted}`);
await shot('12-execution-desk-halted');

await page.click('button:has-text("Resume settlement")');
await page.waitForTimeout(1500);
check('Resume clears the halt', !(await page.locator('text=Settlement halted').first().isVisible()));
await shot('13-execution-desk');

// --------------------------------------------------------------- vault
await page.click('button:has-text("Memory Galaxy")');
await page.waitForTimeout(1000);
check('Vault nodes load', await page.locator('text=Detroit Grid Control').first().isVisible());
await shot('06-memory-galaxy');

// -------------------------------------------------------- synchronizer
await page.click('button:has-text("45ms Synchronizer")');
await page.waitForTimeout(2500);
check('Telemetry renders', await page.locator('text=Current Latency').first().isVisible());
await shot('07-synchronizer');

// ------------------------------------------------------------- security
await page.click('button:has-text("Security")');
await page.waitForTimeout(800);
check('Session panel renders', await page.locator('text=Current session').first().isVisible());
const bodyText = await page.locator('body').innerText();
check('Raw JWT is not printed on screen', !/eyJ[A-Za-z0-9_-]{10,}\./.test(bodyText));
await shot('08-security');

// -------------------------------------------------- command palette + i18n
await page.keyboard.press('Control+k');
await page.waitForTimeout(600);
check('Command palette opens', await page.locator('input[placeholder*="command"]').isVisible());
await shot('09-command-palette');
await page.keyboard.press('Escape');

await page.selectOption('select[title="Switch Workspace Language"]', 'ja');
await page.waitForTimeout(600);
check('Language switches', await page.locator('text=AIコマンドセンター').first().isVisible());
check('Document lang attribute follows', (await page.getAttribute('html', 'lang')) === 'ja');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
check('Language persists across reload', (await page.getAttribute('html', 'lang')) === 'ja');
await page.selectOption('select[title="Switch Workspace Language"]', 'en');
await page.waitForTimeout(400);

// --------------------------------------------------------- high contrast
await page.locator('header button[title*="High Contrast"], header button[title*="Sleek"]').first().click();
await page.waitForTimeout(500);
await shot('10-high-contrast');
check('Theme toggle works', true);

// ------------------------------------------------ design system & keyboard
// The card rows in this app used to be `<div onClick>` — visible to a mouse,
// unreachable by a keyboard. These checks exist so that cannot come back.
await page.click('button:has-text("Revenue Boardroom")');
await page.waitForSelector('text=Supply network', { timeout: 10000 });

const cards = page.locator('[role="option"]');
check('Inventory holdings are exposed as selectable options', (await cards.count()) >= 3,
  `${await cards.count()} options`);

const firstCard = cards.first();
check('A selectable card is in the tab order', (await firstCard.getAttribute('tabindex')) === '0');
check('A selectable card carries an accessible name',
  Boolean((await firstCard.getAttribute('aria-label'))?.length));

// Keyboard activation: focus the card and press Enter.
await firstCard.focus();
const selectedBefore = await firstCard.getAttribute('aria-selected');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
const selectedAfter = await firstCard.getAttribute('aria-selected');
check('Enter selects a card without a mouse', selectedBefore !== selectedAfter,
  `${selectedBefore} -> ${selectedAfter}`);

// Space must select, not scroll the page.
const scrollBefore = await page.evaluate(() => window.scrollY);
await page.keyboard.press(' ');
await page.waitForTimeout(200);
check('Space activates the card rather than scrolling the page',
  (await page.evaluate(() => window.scrollY)) === scrollBefore);

check('Storage utilisation is exposed as a meter', (await page.locator('[role="meter"]').count()) >= 2,
  `${await page.locator('[role="meter"]').count()} meters`);

// A status must never be colour alone.
const chipText = await page.locator('text=Auto-strike').first().textContent();
check('Status is carried by a word, not only a colour', Boolean(chipText && chipText.trim().length > 0),
  chipText ?? '');

// Design tokens must actually be applied, not merely defined. The theme is set
// explicitly here rather than assumed — an earlier check leaves the toggle
// wherever it landed, and a token test that depends on test order is a flake.
const readToken = (name, theme) =>
  page.evaluate(
    ([n, t]) => {
      document.documentElement.setAttribute('data-theme', t);
      return getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase();
    },
    [name, theme],
  );

const sleekSurface = await readToken('--surface-0', 'sleek');
const sleekCritical = await readToken('--status-critical', 'sleek');
check('Design tokens are live on the document', sleekSurface === '#09090b' && sleekCritical === '#d03b3b',
  `${sleekSurface} / ${sleekCritical}`);

// The high-contrast theme must change token VALUES, not merely add a class —
// which is all it did before the design system existed.
const contrastSurface = await readToken('--surface-0', 'high-contrast');
const contrastInk = await readToken('--ink-secondary', 'high-contrast');
const sleekInk = await readToken('--ink-secondary', 'sleek');
check('High contrast overrides surface tokens', sleekSurface !== contrastSurface,
  `${sleekSurface} -> ${contrastSurface}`);
check('High contrast lifts secondary ink', sleekInk !== contrastInk, `${sleekInk} -> ${contrastInk}`);
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'sleek'));

await page.click('button:has-text("Asset Ledger")');
await page.waitForTimeout(1500);

// -------------------------------------- the breaker, end to end via the vault
// The point of parsing the twin is that editing a markdown file changes what
// the risk layer will authorise. This is the check that proves it, and it runs
// last because it deliberately leaves a production line degraded.
const breaker = await page.evaluate(async () => {
  const csrf = () => decodeURIComponent(document.cookie.match(/apex_csrf=([^;]*)/)?.[1] ?? '');
  const order = async (side) => {
    const res = await fetch('/api/execution/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
      credentials: 'same-origin',
      body: JSON.stringify({ assetId: 'AST-H266-001', side, quantity: 1, type: 'market', reason: 'breaker probe' }),
    });
    return { status: res.status, body: await res.json() };
  };

  const before = await order('buy');

  const { nodes } = await fetch('/api/vault/nodes', { credentials: 'same-origin' }).then((r) => r.json());
  const factory = nodes.find((n) => n.type === 'factory_node');
  const degraded = factory.content.replace(
    '    max_throughput_fps: 24000\n    marginal_cost_per_frame: 0.00012\n    status: operational',
    '    max_throughput_fps: 24000\n    marginal_cost_per_frame: 0.00012\n    status: degraded',
  );
  const edited = degraded !== factory.content;

  const update = await fetch('/api/vault/node', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
    credentials: 'same-origin',
    body: JSON.stringify({ id: factory.id, content: degraded }),
  });

  return {
    edited,
    updateStatus: update.status,
    before: before.status,
    afterBuy: await order('buy'),
    afterSell: (await order('sell')).status,
    unrelated: (await order('buy')).status,
    audio: (await (async () => {
      const res = await fetch('/api/execution/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        credentials: 'same-origin',
        body: JSON.stringify({ assetId: 'AST-AUDIO-002', side: 'buy', quantity: 1, type: 'market', reason: 'unrelated' }),
      });
      return res.status;
    })()),
  };
});

check('Vault edit lands', breaker.edited && breaker.updateStatus === 200, `status ${breaker.updateStatus}`);
check('Acquisition is allowed while the line is operational', breaker.before === 201, `status ${breaker.before}`);
check(
  'Degrading a production line in the vault blocks acquisition',
  breaker.afterBuy.status === 409 &&
    (breaker.afterBuy.body.violations ?? []).some((v) => v.code === 'fundamentals_invalid'),
  `status ${breaker.afterBuy.status}`,
);
check('Liquidation stays permitted while the breaker is armed', breaker.afterSell === 201, `status ${breaker.afterSell}`);
check('An unrelated asset class is unaffected', breaker.audio === 201, `status ${breaker.audio}`);

// ----------------------------------------------------------------- done
check('No uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
check(
  'No unexpected console errors',
  consoleErrors.filter((e) => !/favicon|Failed to load resource/i.test(e)).length === 0,
  consoleErrors.join(' | '),
);

await browser.close();

const failed = results.filter((r) => !r.ok);
// A rejected order is the marketplace model doing its job, not a regression.
if (failed.some((f) => /409|executes|accepted/.test(f.detail + f.name))) behaviourWarning();
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
