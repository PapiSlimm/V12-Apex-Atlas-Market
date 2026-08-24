# V12 Apex Atlas — Audit & Remediation Report

Audited against the uploaded archive. Every item below was reproduced before it was fixed, and the fixes are verified by 24 unit tests plus a 27-check browser suite (`scripts/verify.mjs`) run against the production build.

---

## Part 1 — What this app is

**A digital-twin operations workspace with a hard boundary between what an AI agent may advise and what it may authorise.**

The concept underneath the branding is genuinely sound, and it's worth stating plainly because the original code obscured it:

An agent that only sees a database can tell you a warehouse holds 1,420 units. It cannot tell you that warehouse sits downstream of a factory whose energy cost moved, or that selling those units at the quoted price loses money once fees clear. Apex Atlas answers that with two ideas working together:

1. **A human-readable digital twin as ground truth.** Cities, factories and warehouses are markdown notes with `[[wiki-links]]` between them. Humans edit them; the agent reads them. There is no schema-to-prose translation layer to drift out of sync.
2. **Deterministic authority over money.** Trade decisions run through a pure, tested engine. The model can explain a position; it cannot execute one.

**Who benefits:** operations leads who need physical capacity, digital inventory and live economics on one surface; trading and treasury desks running rule-based liquidation who need the rule enforced where a UI bug can't bypass it; solutions engineers who need an inspectable demo; internal tools teams who want generated UI without giving a model write access to production code.

**The honest caveat:** as shipped, the market data is simulated and no order reaches a venue. That was not disclosed anywhere in the original UI, which is the most consequential non-technical problem in the archive — see finding S1.

---

## Part 2 — Findings

Severity: **C**ritical (feature does not work / money or credentials at risk) · **H**igh · **M**edium · **L**ow

### C1 — The REPL harness could never compile anything. Ever.

`UI4AReplHarness.tsx` did this:

```js
new Function('React', `return function C({data}) { ${code} };`)
```

`code` is raw JSX. `new Function` invokes the JavaScript parser, which has no concept of `<div>`. Reproduced directly:

```
$ node -e "new Function('React','return function C(){ return (<div/>); };')"
THROWS: SyntaxError - Unexpected token '<'
```

Every compilation threw before rendering anything, in dev and in production, for the default template as well as model output. The headline feature of the product — the thing on the sidebar badge, in the metadata description and in three of the six module names — has never worked once.

**Fixed.** Added `src/lib/compileArtifact.ts`: normalises the several shapes models emit (bare JSX, bare function body, full declaration, `export default`, stray markdown fences), transpiles JSX → `React.createElement` with Babel, then instantiates. Babel is dynamically imported so it code-splits into its own chunk and never touches the initial payload; it is preloaded in the background when a REPL-capable tab mounts. Covered by 8 unit tests and 4 browser checks including a live-edit recompile and a deliberately broken source.

### C2 — A throwing artifact unmounted the entire application

There was no error boundary anywhere. React's default on an uncaught render error is to unmount the whole tree — so one bad generated component turned the workspace into a blank white page with no route back except a manual reload.

**Fixed.** Added `ErrorBoundary` with a reset control, wrapped around both every module (keyed on the active tab) and every compiled artifact (keyed on source, so a recompile clears a prior crash). Verified: after feeding the harness broken source, the app still renders.

### C3 — The zero-loss guarantee was not enforced, and profit was overstated

`POST /api/hermes/trade` accepted the client's assertion of what should happen and executed it:

```js
if (action === 'EXECUTE_SELL') {
  const profit = (asset.current_price - asset.acquisition_price) * asset.quantity;
```

Three distinct defects in four lines:

- **The evaluation was never consulted.** Any authenticated caller could POST `EXECUTE_SELL` against an asset the engine would have refused — below the stop, below the strike, or not a guaranteed instrument. The "zero-loss mandate" existed only in the advisory endpoint the client was free to skip.
- **Fees were ignored.** `/evaluate` correctly computed `offer × (1 − sell_fees) − basis × (1 + buy_fees)`. `/trade` used the raw spread. On the seeded H266 position that is a **$951.40 overstatement on a single trade** ($6,106.00 reported vs $5,154.60 actual).
- **Wrong price.** `/evaluate` decided on `active_offer`; `/trade` settled at `current_price`. The two could differ, so the engine could approve one economics and the ledger record another.

**Fixed.** Extracted `server/hermes.ts` — pure functions, no HTTP — and both endpoints now call it. `authoriseSell()` is the execution gate: the trade route refuses anything it doesn't sanction with `409` plus the engine's reasoning. Fees are charged on both legs everywhere. Also added: flat positions can't be re-sold, role checks (`Executive` / `Arbitrage Trader` / `System Admin`), and an explicit `zero_loss_satisfied` flag so a stop-loss exit is never mislabelled as a profitable one. 13 unit tests, live-verified:

```
AST-COMPUTE-003 (not guaranteed)     → 409 Execution refused
AST-H266-001 (clears strike, net +)  → 200, net $5,154.60
AST-H266-001 again (position flat)   → 409 Position is already flat
```

### C4 — Committed JWT secret, and a hardcoded fallback

`.env.example` shipped `JWT_SECRET="v12_apex_atlas_jwt_secret_key_2026"`, and `server.ts` used that exact string as its fallback. Anyone with the repo could mint a valid `System Admin` token against any deployment that hadn't overridden it.

**Fixed.** Production refuses to boot without a `JWT_SECRET` of ≥32 characters. Development generates an ephemeral one per process and warns. `.env.example` ships empty with a `openssl rand -hex 32` hint.

### C5 — Session token in `localStorage`, in an app that evals model output

`localStorage.getItem('v12_jwt_token')` appeared in four components, and `SecurityAuth.tsx` printed the full bearer token on screen. Combined with C1's intended behaviour — executing model-generated code in the page — that is a complete credential-exfiltration path: any generated component could read the token and POST it anywhere. The on-screen display added a second leak into every screenshot, screen-share and support ticket.

**Fixed.** Sessions moved to an `httpOnly`, `SameSite=Strict`, 12-hour cookie. Client JS never touches a token; `src/lib/api.ts` replaced all four ad-hoc fetch sites. The Security panel now explains the storage model instead of printing the credential. Verified in-browser: `localStorage` contains no token-like key, the cookie carries both flags, and no JWT-shaped string appears in the DOM.

### H1 — AI endpoints were unauthenticated and unthrottled

`/api/gemini/chat` and `/api/gemini/genui` had no auth and no rate limit. Anyone who found the URL could spend your Gemini quota at whatever rate they liked.

**Fixed.** Both require a session and are limited to 20 requests/minute. Auth routes limited to 20 per 15 minutes. `helmet` added with a CSP that permits `'unsafe-eval'` (the REPL needs it) and locks down everything else — the httpOnly cookie from C5 is what makes that trade-off acceptable. Body size capped at 256 kB.

### H2 — Production served the backend bundle and its sourcemap

`npm run build` wrote the client to `dist/` and `esbuild --sourcemap` wrote `dist/server.cjs` + `dist/server.cjs.map` into the same directory — which `express.static(dist)` then served. `GET /server.cjs.map` published the full annotated server source, including auth logic, to anyone who asked.

**Fixed.** Client builds to `dist/client`, server to `dist/server.cjs`, and only `dist/client` is served. Server sourcemaps removed from the production build. Verified: `/server.cjs` now returns the SPA shell, and grepping the response for `JWT_SECRET` yields zero hits.

### H3 — All data was lost on every restart

Users, vault edits and executed trades lived in module-scope arrays. Register an account, edit a note, execute a trade — restart the process and all of it silently vanished.

**Fixed.** `server/db.ts` provides a file-backed JSON store with debounced atomic writes (temp file + rename) and flush-on-exit/SIGINT/SIGTERM. Deliberately small and behind one interface so it can be swapped for a real database without touching route code. Trade history is now server-owned and survives reload.

### H4 — React types were never installed, so `tsc` was checking nothing

React 19 doesn't bundle its own types and `@types/react` was absent from `package.json`. Every React type resolved to implicit `any`. `npm run lint` passed cleanly while providing essentially zero coverage of the UI — which is a large part of how C1 shipped.

**Fixed.** Installed `@types/react` / `@types/react-dom`, and enabled `strict` + `noUnusedLocals`. Surfaced 8 real issues (all dead imports and an unused binding); the codebase now typechecks clean under strict mode.

### M1 — Chat history was accepted and thrown away

The endpoint destructured `history` from the body and never referenced it again. The assistant had no memory across turns, and the client never sent history anyway.

**Fixed.** The client sends the last 12 turns; the server maps them to `role: user | model` and includes them in the request.

### M2 — Fabricated model identifier

`gemini-3.6-flash` is not a real model. Every model call would 404 and fall into the catch block, so the app permanently served fallback content while presenting it as generated output.

**Fixed.** Defaults to `gemini-2.5-flash`, overridable via `GEMINI_MODEL`. When no API key is configured or a call fails, the response is explicitly tagged `source: 'fallback'` with a reason, and the UI says so rather than passing a template off as model output.

### M3 — The latency-alert path was unreachable

`/api/sync/telemetry` returned 42–48 ms; the client alerted above 200 ms. The alert could never fire — dead code that looked like a working monitor.

**Fixed.** The generator emits a realistic spike tail (~4% of samples land in the 210–390 ms band), so the path is exercised. Verified live.

### M4 — Routing gate resolved on branch order, not intent

The router was an `if/else if` chain, so the first matching branch won regardless of strength. "Fix the arbitrage dashboard" matched `dashboard` in the first branch and went to GenUI even though it names two other domains.

**Fixed.** Every rule is scored by term matches and the strongest wins; the match count is returned so the decision is inspectable.

### M5 — Silent failures throughout the client

Nine `catch` blocks did nothing but `console.error`. Failed generations stopped a spinner and showed nothing. Failed trades used a raw `alert()`. Failed vault saves left the note looking saved.

**Fixed.** `ApiError` carries status and server message; every module surfaces failures inline and via toast. `alert()` removed. A 401 anywhere reopens the sign-in modal.

### M6 — Chat did not scroll to new messages

No scroll anchor. Every dispatch appended below the fold and the operator had to scroll manually to see the reply.

**Fixed.** Scroll anchor with smooth `scrollIntoView` on message and processing-state change.

### M7 — Portfolio figures were hardcoded marketing numbers

"Total Ecosystem Valuation $12,482,900.50" and "Total Realized 24h Revenue +$412,400.00" were string literals with no relationship to the positions on screen. On a financial surface that is worse than showing nothing.

**Fixed.** Mark value, cost basis (including buy fees), unrealised net and realised P&L all derive from actual positions and the server-side trade log.

### M8 — Language reset on every reload

Theme persisted to `localStorage`; language did not. Every refresh snapped Japanese and Chinese users back to English.

**Fixed.** Persisted, with a `navigator.language` first-run default, and `document.documentElement.lang` kept in sync so assistive tech announces content correctly.

### M9 — Modals were keyboard traps

`AuthModal` had no Escape handler, no focus management, no `role="dialog"`, and no backdrop dismissal. A keyboard-only user who opened it could not get out.

**Fixed.** Escape closes, focus moves to the first field on open and returns to the trigger on close, Tab cycles within the dialog, backdrop click dismisses, proper ARIA. The snapshot modal got the same treatment.

### L1–L7 — Smaller items, all fixed

- **L1** Title was "My Google AI Studio App"; no description, favicon, or `theme-color`. Now branded with a full meta block and an inline SVG favicon.
- **L2** README was Google AI Studio boilerplate that described none of this. Rewritten around what the app does and who it's for.
- **L3** Raw LaTeX (`$\Delta_\pi > 0$`) rendered literally as source text in two components. Replaced with the character.
- **L4** Toast timers were never cleared on unmount. Now tracked and cleaned up.
- **L5** Registration accepted any-length passwords and could self-assign any role. Now 12-character minimum, bcrypt cost raised 10 → 12, and `System Admin` is not self-assignable. Login compares against a dummy hash for unknown accounts so timing doesn't leak account existence.
- **L6** Sidebar labels were ellipsised into uselessness ("Revenue Boardr…") and the header tagline wrapped off its grid. Widened and shortened.
- **L7** The app shell used `min-h-screen`, so the document scrolled and the nav sidebar slid off the top instead of the main panel scrolling in its own frame. Now `h-screen` with internal scroll regions.

### S1 — Simulated data presented as real, with no disclosure

Not a code defect, but the most consequential problem in the archive. The Revenue Boardroom displayed acquisition prices, live offers, profit percentages, a "24/7/366 ARBITRAGE" badge, a "$12.4M ecosystem valuation" and an "EXECUTE ZERO-LOSS TRADE" button — with nothing anywhere indicating the numbers were generated by a simulator and that pressing the button moved no money. Someone could reasonably have believed they were looking at a live trading desk.

**Fixed.** A persistent disclosure banner tops the Boardroom; API responses carry `simulated: true`; trade records are stamped `simulated`; the chat system prompt instructs the assistant to say so and forbids it from claiming a trade executed. Given this is a product in progress rather than a demo, the seams for real data are marked in the README's *Known limits*.

---

## Part 3 — Improvements beyond fixes

- **`server/hermes.ts` extracted as a pure module.** The decision logic is now testable without HTTP, shared by both endpoints by construction, and the natural place to add partial fills, position sizing or a broker adapter.
- **`src/lib/api.ts`** replaced four divergent hand-rolled fetch patterns with one wrapper that handles JSON, non-JSON, network failure and server error messages consistently.
- **A test suite where there was none.** 24 unit tests over the engine and the compiler, plus `scripts/verify.mjs` — 27 browser assertions against the production build covering the REPL fix, cookie flags, absence of a token in `localStorage`, absence of a JWT in the DOM, i18n persistence, and a zero-console-error requirement.
- **`/api/health`** for load balancers and uptime checks, reporting whether the model is actually configured.
- **`/api/auth/me` returns 200 with `user: null` when signed out**, so the normal anonymous first paint stops logging a 401 to the console.
- **Capability matrix rendered from the same role lists the server enforces**, so the Security panel cannot drift from actual policy.
- **Skip-to-content link, ARIA labels on every icon-only control, keyboard-operable position list.**

---

## Part 4 — What I'd do next

1. **Move REPL execution into a cross-origin sandboxed iframe.** The httpOnly cookie closes the credential path, but generated code still runs with page privileges. This becomes necessary the moment artifacts are shared between accounts.
2. **Replace the JSON store with Postgres.** `server/db.ts` is single-process; it is the only thing standing between this and horizontal scaling.
3. **Wire a real price feed and broker adapter.** The engine is ready — it needs a source that isn't `Math.random()` and an execution path that leaves the process.
4. **Add partial fills and position sizing.** Liquidating whole positions is a modelling simplification that won't survive contact with a real desk.
5. **Persist an immutable audit log.** Every refusal is currently reasoned but not retained. For anything money-adjacent, refusals matter as much as fills.
6. **Add CSRF double-submit tokens.** `SameSite=Strict` covers the realistic cases today; add defence in depth before exposing the API to third-party clients.

---

## Verification

```
npm run lint    →  clean (strict mode, React types installed)
npm test        →  24/24 passing
npm run build   →  dist/client (client) + dist/server.cjs (server), separated
verify.mjs      →  27/27 browser checks passing against the production build
```

