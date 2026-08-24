# Stage 2 — Production Hardening

Follow-on to `AUDIT.md`. That stage made the app work and closed the bugs that made it dangerous. This stage works the roadmap it ended with: real storage, an audit trail, CSRF, and moving generated code somewhere it cannot hurt anything.

Verified by 47 unit tests (the store suite runs against **both** backends), 46 browser checks against the production build, and manual tamper and concurrency probes.

---

## 1. Storage: from a JSON file to a real database — twice

**Where it was.** Users, vault notes and trades lived in one JSON file rewritten wholesale on a debounce. Single-process, no transactions, no constraints, and a partial write away from losing everything.

**What it is now.** A `Store` interface (`server/store/types.ts`) with two implementations behind one factory:

- **SQLite** (default, `better-sqlite3`) — WAL mode, real transactions, `CHECK (quantity >= 0)` at the schema level. Zero configuration; works the moment you clone the repo.
- **Postgres** (set `DATABASE_URL`) — pooled, and the one you deploy.

The leverage is in how little is duplicated. Every query string, every row mapping and the whole audit protocol live once in `server/store/sql-store.ts`. The backends differ in exactly three places: DDL types, placeholder syntax (`?` is rewritten to `$n`), and how a lock is taken. JSON-shaped columns are TEXT in both rather than `jsonb`, which gives up in-database querying nothing needs and buys byte-identical round-tripping the hash chain does need.

**What keeps them honest.** `tests/store.test.ts` is a conformance suite, not two suites. It runs against SQLite always and Postgres whenever `TEST_DATABASE_URL` is set. Both pass identically today; a divergence fails the build rather than surfacing in production.

**A real bug this surfaced.** The Postgres implementation carries its transaction client through `AsyncLocalStorage`. Without that, a query issued inside `transaction()` gets checked out on a *different* pooled connection and silently runs outside the transaction — for the audit chain that means appends that look committed but were never covered by the lock. This is the kind of thing that works fine until it doesn't, at 3am.

**Migration.** A `data/apex-atlas.json` from the previous build is imported on first boot and renamed to `.imported` rather than deleted. Anyone who ran the earlier version keeps their accounts, edits and history.

### The concurrency bug the tests caught

Two problems, both invisible until storage went async.

**Double-spend on liquidation.** The old flow read the position, checked it, then zeroed it. With a synchronous in-memory store there was no `await` between those steps, so it was *accidentally* safe. With a real database there is, and two concurrent requests could both pass the Hermes gate and both sell the same inventory — booking the profit twice and driving quantity negative.

Liquidation is now one statement:

```sql
UPDATE assets SET quantity = 0, active_offer = NULL
WHERE asset_id = ? AND quantity > 0
RETURNING *
```

The `quantity > 0` predicate is a compare-and-swap: the second request matches zero rows and is refused. `tests/store.test.ts` fires three concurrent liquidations at one position and asserts exactly one wins.

**Transaction collision in SQLite.** `better-sqlite3` is synchronous over a single connection, but `transaction()` awaits its callback — so a second caller could `BEGIN` while the first was still open, and SQLite rejects that outright:

```
SQLiteError: cannot start a transaction within a transaction
```

Two audit appends in the same tick was enough. Under load this means dropped audit records — the failure mode you least want in the component whose whole job is not losing records. Fixed with an in-process transaction queue. **The conformance test found this, not a user.**

---

## 2. Tamper-evident audit log

Every execution decision is appended to `audit_log` before the response is sent: fills, refusals, authorisation denials, vault edits, failed logins.

**Refusals are the point.** A log of what a system did is half a record. When someone asks why a position wasn't liquidated on the 14th, "the engine returned `HOLD_REJECT_OFFER` because fees erased the margin, here is the evaluation" is the answer — and that only exists if refusals are recorded with the same weight as fills.

**The chain.** Each entry stores `prev_hash` and `hash = sha256(prev_hash + canonical(entry))`. Modifying, deleting or reordering any historical row invalidates every hash after it. Canonicalisation sorts keys recursively, so a round-trip through a different driver is not mistaken for tampering.

**Verified end to end, not just asserted:**

```
$ sqlite3: UPDATE audit_log SET detail='{"reason":"nothing to see here"}' WHERE seq=1
$ curl /api/health
{"status":"degraded","auditChain":{"ok":false,"entries":2,"brokenAt":1}}
```

The health endpoint verifies the chain on every call, so an uptime monitor pages on database tampering without anyone building a separate alert.

Postgres additionally carries rules making `UPDATE` and `DELETE` on `audit_log` no-ops at the schema level:

```
$ UPDATE audit_log SET detail='{}' WHERE seq=1;   → UPDATE 0
$ DELETE FROM audit_log WHERE seq=1;              → DELETE 0
```

**Honest limit:** this makes tampering *detectable*, not impossible. Anyone with write access can still rewrite history — they cannot do it without breaking the chain. Shipping chain heads off-box is the next increment.

A new **Decision Audit Log** module renders the chain, filters allowed/refused, expands each entry's hashes and payload, and exports the log with its chain for an auditor.

---

## 3. CSRF double-submit

`SameSite=Strict` already blocks the realistic cases, but it is one browser bug or one relaxed cookie setting away from being the only thing between an attacker's page and an authenticated `POST /api/hermes/trade`. On a route that moves value, defence in depth is cheap.

A random token is set in a **readable** cookie beside the httpOnly session. The client echoes it in `X-CSRF-Token`. A cross-origin page can make the browser *send* cookies but cannot *read* them, so it cannot produce the header. Compared with `crypto.timingSafeEqual`.

Bearer-authenticated requests are exempt — those are not sent automatically by the browser, so they are not forgeable cross-origin, and requiring the header would break API clients for no gain.

Verified in-browser: a cookie-authenticated `POST /api/hermes/trade` with no header returns `403 {"code":"csrf_failed"}` even though the session cookie was attached.

---

## 4. Generated code moved off the application origin

**The problem.** Executing model-generated code is the REPL's purpose, but running it in the app's own document gives it the app's privileges: same-origin fetch, storage, the parent DOM. Stage 1 closed the credential path by moving the session into an httpOnly cookie. It did not stop generated code from calling the API as you, reading the page, or exfiltrating whatever it found.

**The fix.** Artifacts now render in an iframe loaded with `sandbox="allow-scripts"` and deliberately **without** `allow-same-origin` — which puts the document on an opaque origin even though it is served from our host. The `/repl-sandbox` route sets its own CSP, much stricter than the app's:

```
default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval';
style-src 'unsafe-inline'; img-src data: blob:; font-src data:;
connect-src 'none'; form-action 'none'; base-uri 'none'
```

`connect-src 'none'` means no network egress at all. The worst a hostile artifact can do is draw the wrong pixels.

Browser-verified, not assumed — from inside the frame:

| Probe | Result |
| --- | --- |
| `window.origin` | `null` (opaque) |
| `document.cookie` | blocked |
| `localStorage` | blocked |
| `window.parent.document` | blocked |
| `sandbox` attribute | `allow-scripts`, no `allow-same-origin` |

**The bonus, and it is a big one.** With execution gone, the last `new Function` left the application origin — Babel parses and prints but never evaluates. So production CSP is now:

```
script-src 'self'
```

**No `'unsafe-eval'` anywhere in the app.** The inversion is the whole argument: the only document that can eval is the one with no cookies, no storage and no network. `'unsafe-eval'` remains in development only, because Vite's HMR needs it.

Two practical details worth noting: the parent transpiles JSX and sends the *result*, so Babel ships once rather than twice; and the parent forwards its stylesheet text over `postMessage`, because a `connect-src 'none'` frame cannot fetch the Tailwind CSS itself. Replies are authenticated by comparing `event.source` against the iframe's `contentWindow` — an origin check would be meaningless against a document whose origin serialises to `"null"`.

---

## Verification

```
npm run lint     → clean (strict mode)
npm test         → 47/47   (SQLite conformance + engine + compiler + chain)
TEST_DATABASE_URL=… npm test
                 → 38/38   (adds full Postgres conformance)
npm run build    → dist/client + dist/client/repl-sandbox.js + dist/server.cjs
verify.mjs       → 46/46   against SQLite backend
verify.mjs       → 46/46   against Postgres backend
```

Manual probes: audit tampering detected and reported as `degraded`; Postgres `UPDATE`/`DELETE` on `audit_log` are no-ops; audit entries and chain survive a process restart; three concurrent liquidations yield exactly one fill.

---

## What's next

The roadmap that remains, in the order I would take it:

1. **A real price feed and broker adapter.** The engine, the audit trail and the concurrency guarantees are all ready for real data now. This is the last thing standing between the current build and a system that does something.
2. **Partial fills and position sizing.** Whole-position liquidation is a modelling simplification that will not survive contact with a real desk.
3. **Ship audit chain heads off-box.** Periodically publish the latest hash somewhere the application cannot write. That upgrades tamper-*evident* to tamper-*evident-and-provable*.
4. **Move the sandbox to a distinct hostname.** Opaque origin already blocks the practical attacks; a separate origin additionally defeats same-site cookie attacks. Worth doing before artifacts are ever shared between accounts.
5. **Redis-backed rate limits.** Currently per-process and in-memory, so they weaken behind more than one instance.
6. **Structured request logging with correlation IDs**, so an audit entry can be traced back to the request that produced it.
