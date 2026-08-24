# V12 Apex Atlas

**An operations workspace that keeps an AI agent, a model of your production network, and an auditable inventory-settlement engine in the same room.**

Most "AI copilot" dashboards are a chat box bolted to a database. The agent knows the schema but not the business: it can tell you a warehouse holds 1,420 units, but not that the warehouse sits downstream of a factory whose energy cost just moved, or that liquidating those units at the quoted price loses money once fees clear. Apex Atlas is built on the opposite premise — the model should be grounded in an explicit, human-readable map of the operation, and anything with financial consequence should be decided by deterministic code the agent cannot talk its way past.

---

## What it actually is

Eight modules over one shared state.

| Module | What it does |
| --- | --- |
| **AI Command Center** | A chat terminal fronted by a routing gate that scores each query and dispatches it to one of four specialist profiles (chat, workflow agent, UI generation, code). The selected specialist and its matched-term count appear on every message, so you can see *why* a query went where it went. The weights shown are the fixed profile of that specialist, not a learned blend. |
| **Revenue Boardroom** | The Hermes engine. Evaluates every open position against a stop-loss floor and a profit-strike target, **net of both fee legs**, then either authorises or refuses execution. The refusal path is the product. |
| **Memory Galaxy** | The digital twin: a graph of interlinked markdown notes describing cities, factories and warehouses, with `[[wiki-links]]` between them. This is the agent's ground truth, and humans edit it in the same format the agent reads. |
| **UI4A REPL Harness** | Describe an interface in a sentence; the model writes a React component; the harness transpiles and renders it live. Also a plain editor, so you can take over from the model mid-thought. |
| **45ms Synchronizer** | A modelled replication-latency stream against the vault, with a rolling 50-event buffer exportable as CSV. Latency figures are generated; the audit chain head shown beside them is real. |
| **Session & Access** | Cookie-backed sessions, the role-to-capability matrix as it is actually enforced on the server, and the inactivity policy. |
| **Asset Ledger** | The media-inventory book: modelled bids from the internal marketplace, fill-derived positions with fee-inclusive cost basis, in-flight instructions, the sized settlement plan, risk limits, and the kill switch. |
| **Decision Audit Log** | Every execution decision, hash-chained and append-only — including the refusals. Tampering with a historical record breaks the chain and the health endpoint reports `degraded`. |

## Who it's for

- **Operations leads** who need one surface showing physical capacity, digital inventory and live economics together, instead of three tabs that disagree.
- **Production and inventory managers** running rule-based liquidation of finished media inventory, who need the profit floor enforced somewhere a UI bug cannot bypass — and an audit trail of every refusal, not just every fill.
- **Solutions engineers** demoing agentic operations to a customer, who need the demo to be inspectable rather than a black box.
- **Internal tools teams** who want generated UI without handing a model write access to production code.

## The idea worth keeping

**Advisory and authority are separated.** The model can read the twin, explain a position and draft an interface. It cannot move value. Execution runs through `server/hermes.ts` — pure functions, unit-tested, invoked identically whether you are previewing a decision or committing one. The client's opinion about what should happen is never consulted: it asks, the server decides. That boundary is what makes an agentic system safe enough to trust with inventory that has a book value, and it is the part of this codebase most worth carrying into whatever it becomes next.

The same principle runs through the rest of the design. Generated code executes on an opaque origin with no network access, so the REPL cannot reach anything it was not handed. Every decision — allowed or refused — is committed to a hash chain before the response is sent. The privileged surface is small, explicit, and observable.

---

## Running it

```bash
npm install
cp .env.example .env      # then fill it in — see below
npm run dev               # http://localhost:3000
```

Production:

```bash
npm run build             # client → dist/client, server → dist/server.cjs
npm start
```

Checks:

```bash
npm run lint              # tsc --noEmit, strict mode
npm test                  # engine, ledger, execution, store conformance, audit chain
node scripts/verify.mjs http://localhost:3000   # 86-check browser suite — needs a FRESH instance
                                               # booted with MARKET_BEHAVIOUR=calm
npm run verify:tenancy                         # cross-tenant isolation, over HTTP
npm run preflight https://your-deployment      # deployment blockers: marketplace, demo users, CSP, twin
npm run verify:beta https://your-deployment    # invite gate and population cap, over HTTP

# Run the store conformance suite against Postgres too:
TEST_DATABASE_URL=postgres://user@host/db npm test
```

### Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `JWT_SECRET` | **yes in production** | ≥32 random characters. The server refuses to boot in production without it. In development an ephemeral secret is generated per process. |
| `GEMINI_API_KEY` | no | Without it every model feature degrades to a clearly-labelled local fallback. Routing, Hermes, the vault and telemetry are deterministic and work regardless. |
| `GEMINI_MODEL` | no | Defaults to `gemini-2.5-flash`. |
| `PORT` | no | Defaults to 3000. |
| `DATABASE_URL` | no | Postgres connection string. When unset, SQLite is used at `$DATA_DIR/apex-atlas.db`. |
| `DATA_DIR` | no | Where the SQLite database lives. Defaults to `./data`. |
| `SQLITE_PATH` | no | Override the SQLite file path directly. |
| `PGSSL` | no | Force TLS for Postgres (also inferred from `sslmode=require`). |
| `TEST_DATABASE_URL` | no | Runs the store conformance suite against Postgres in addition to SQLite. |
| `MARKET_BEHAVIOUR` | no | `realistic` (default) or `calm`. Realistic injects partial fills, rejections and dropped connections into the internal marketplace. |
| `RISK_MAX_ORDER_NOTIONAL` | no | Single-order ceiling. Default 250,000. |
| `RISK_MAX_DAILY_NOTIONAL` | no | Rolling 24h ceiling. Default 1,000,000. |
| `RISK_MAX_POSITION_NOTIONAL` | no | Per-position concentration cap. Default 500,000. |
| `RISK_MAX_QUOTE_AGE_MS` | no | Refuse to act on bids older than this. Default 5,000. |
| `RISK_START_HALTED` | no | `true` boots with the kill switch engaged. |
| `MULTI_TENANT` | no | `true` enables per-organisation signup. Default `false` — one organisation, for self-hosted and desktop. |
| `DEFAULT_TENANT_NAME` | no | Display name for the single-tenant organisation. |
| `DEFAULT_TENANT_PLAN` | no | Plan for the default tenant. Defaults to `enterprise`. |
| `INVITE_ONLY` | no | `true` requires a valid invite code to register. Mint with `npm run invite -- mint`. |
| `BETA_MAX_TENANTS` | no | Hard ceiling on organisations. Independent of invites; 0 disables. |
| `AI_INPUT_CENTS_PER_MTOK` | no | Input token price, cents per million. Unset means high placeholder rates. |
| `AI_OUTPUT_CENTS_PER_MTOK` | no | Output token price, cents per million. |
| `ADMIN_API_TOKEN` | no | Enables the invite-minting API. Unset means those routes are **not mounted**. ≥32 chars or the server refuses to boot. |
| `ADMIN_IP_ALLOWLIST` | no | Comma-separated exact IPs permitted to call the admin API. |
| `ENABLE_DEMO_USERS` | no | Set to `true` to seed two demo accounts. **Never enable in production.** |
| `DEMO_PASSWORD` | no | Password for those demo accounts. |

### Roles

Enforced server-side by `requireRole`, and mirrored in the Security module so the UI cannot drift from the actual policy:

| Capability | Executive | Arbitrage Trader | LoRABlender Engineer | System Admin |
| --- | :-: | :-: | :-: | :-: |
| Place / cancel orders | yes | yes | — | yes |
| Halt trading | yes | yes | — | yes |
| Resume trading, reconcile | yes | — | — | yes |
| Edit vault nodes | yes | — | yes | yes |
| Read the audit log | yes | — | — | yes |
| Call model endpoints | yes | yes | yes | yes |
| Read positions / vault | public | public | public | public |

Self-service registration cannot assign `System Admin`.

---

## Architecture

```
server.ts                    HTTP layer: auth, rate limits, CSP, routes, static host
server/hermes.ts             Legacy asset-model engine (still serves the Boardroom)
server/twin/
  types.ts                   GeographicHub, FactoryNode, ProductionLine, WarehouseNode, InventoryBlock
  frontmatter.ts             YAML frontmatter + Obsidian wiki-link reading
  graph.ts                   Vault -> typed graph, plus the structural validator
  valuation.ts               Strike/stop floors, net yield, ecosystem valuation
server/assets/
  types.ts                   AssetSpec, Quote, Order, Fill, Position; the state machine
  ledger.ts                  Position accounting from fills — pure, property-tested
  strategy.ts                Hermes as a SIZED execution plan
  risk.ts                    Pre-settlement limits and the kill switch
  marketplace.ts             Marketplace / BidFeed contracts
  internal-marketplace.ts    The only implementation: deliberately hostile — partials, rejects, drops
  execution.ts               Placement, fill ingestion, reconciliation
  index.ts                   Runtime wiring and boot reconciliation
server/csrf.ts               Double-submit CSRF protection
server/sandbox.ts            Serves the isolated REPL document with its own strict CSP
server/store/
  types.ts                   The storage contract — everything above talks only to this
  sql-store.ts               Shared SQL implementation; both backends inherit it
  sqlite.ts                  Default backend (better-sqlite3, WAL)
  postgres.ts                Production backend (pg, pooled)
  chain.ts                   Audit hash chain: canonical hashing and verification
  index.ts                   Backend factory, first-run seeding, legacy JSON import
server/seed.ts               Twin nodes and asset definitions
src/lib/api.ts               Fetch wrapper; handles CSRF, never touches the session token
src/lib/compileArtifact.ts   JSX → React.createElement. Transpiles only; never executes
src/repl-sandbox/runtime.tsx Runs inside the sandboxed iframe (separate bundle)
src/design/                  Tokens plus GlassPanel, QuantumCard, Button, StatTile,
                             HeroFigure, Meter, StatusChip, Alert, DataTable
src/components/              Eight modules plus the shell
tests/                       Node test runner: engine, compiler, store conformance, chain
scripts/verify.mjs           Playwright browser suite
scripts/preflight.ts         Deployment blockers and warnings
scripts/verify-tenancy.ts    Cross-tenant isolation probe over HTTP
scripts/build-sandbox.mjs    Builds the sandbox runtime
```

### Tenancy

Multi-tenant, with isolation enforced by the **type system** rather than by
discipline: every scoped store method takes `TenantId` as its first parameter
and there is no overload that omits it. A route that forgets to scope a query
does not leak data — it fails to compile.

- The tenant is carried in the signed session, never read from a request body.
- Each tenant has its **own audit chain**, starting at sequence 1. A shared
  counter would leak other customers' activity volume through the gaps in yours.
- Each tenant has its **own marketplace instance and its own book**. Two
  tenants sharing one order book would make the isolation tests pass for the
  wrong reason.
- Plan entitlements (seats, trading, AI credit) are enforced server-side, in the
  one place a seat is actually consumed.

Single-tenant deployments — self-hosted and desktop — leave `MULTI_TENANT`
unset, land everyone in one organisation, and pay one extra column for the
privilege.

Two of the three bugs this work surfaced were at the route layer, not the store
layer, which is why `npm run verify:tenancy` probes isolation over HTTP as well.

### Storage

One interface, two implementations, one conformance suite that both must pass —
which is the only thing that keeps a second backend honest.

- **SQLite** (default, zero config): WAL mode, real transactions, an in-process
  transaction queue so concurrent audit appends serialise instead of colliding.
- **Postgres** (set `DATABASE_URL`): pooled, with the transaction client carried
  through `AsyncLocalStorage` so shared query code cannot accidentally run
  outside its transaction. `audit_log` additionally carries rules that make
  `UPDATE` and `DELETE` no-ops at the schema level.

Liquidation is a single compare-and-swap statement (`WHERE quantity > 0`), so two
concurrent trade requests cannot both sell the same position.

If a `data/apex-atlas.json` from the earlier build is present, it is imported on
first boot and renamed to `.imported` rather than deleted.

### Execution

Positions are **derived from fills**, never stored as truth. Storing both means
two sources that will disagree, and the disagreement always surfaces as money
that does not add up. The accounting holds one invariant at every point in every
fill sequence:

```
realisedPnl − quantity × averageCost === cashFlow
```

`tests/ledger.test.ts` asserts it after every fill across 2,000 randomised
sequences, covering longs, shorts, partial reductions and fills that cross
through flat.

Three properties matter more than the rest:

- **`clientOrderId` is an idempotency key.** The order row is persisted *before*
  the marketplace is called. When `place()` times out, we query by that id
  rather than retrying — a blind retry is how one intent becomes two positions.
- **Reconciliation on boot.** Open instructions are diffed against the
  marketplace and fills are replayed from a stored cursor, so a process that
  dies mid-instruction converges on restart. Disagreements are reported and halt
  settlement rather than being silently patched.
- **The marketplace model is hostile on purpose.** It partially fills, rejects,
  stalls and drops connections. A model that always fills instantly tests
  nothing, because most execution bugs are handling bugs.

**There is one marketplace and it is internal.** The assets here are the media
products this business manufactures — H.266 video blocks, synthesised audio
streams, compute matrices — and the marketplace is where bids for them arrive.
Apex Atlas has no external exchange integration, and `npm run preflight` fails
with a **blocker** if a marketplace other than `internal` ever shows up in
`/api/health`.

That check exists because this repository briefly did contain a crypto-exchange
adapter. It was written on a misreading of the specification, and it is gone.
The preflight blocker is there so the mistake cannot return quietly.

### The vault is the database

The specification is explicit that the digital twin lives in Obsidian: markdown
files with YAML frontmatter, editable by a human and readable by an agent over
MCP. `server/twin/` honours that literally — the supply graph is **parsed from
the frontmatter on every request** rather than duplicated into its own tables.

Concretely, this is what that buys:

- **The boardroom computes rather than displays.** Ecosystem valuation, buffer
  load, strike floors and net yield are all derived. The figures in the
  specification's own dashboard mock-up were constants; these move when you edit
  a file. The 42% buffer load it shows falls out of 1,420 blocks x 1.48 TB
  against 5,000 TB of declared capacity.
- **Marking a production line `degraded` in Obsidian blocks acquisition of what
  that line makes** — within the same request, not the next restart. Liquidation
  stays permitted, because that is what a breaker is for. The browser suite
  proves this end to end: edit the vault, watch a buy turn into a 409.
- **The vault is validated like code.** Dangling wiki-links, one-sided
  factory/warehouse relationships, inventory no upstream line can produce, and
  over-allocated storage are all reported, and `npm run preflight` refuses to
  pass a deployment whose twin has structural errors.

Parsing never throws. A vault file with broken YAML becomes one reported issue
on one node; every other file still parses. `js-yaml` does the parsing — writing
a YAML subset by hand is a well-known way to be subtly wrong for years.

One field was added to the specification's schema: `block_size_tb` on each
inventory block. `storage_capacity_tb` is unusable without it, and utilisation
reports `null` rather than `0%` when it is missing, because a warehouse that
reads as empty because of an absent field is the worst way to be missing data.

### Security posture

- **Generated code runs on an opaque origin.** The REPL renders into an iframe with `sandbox="allow-scripts"` and deliberately no `allow-same-origin`, served with its own CSP: `default-src 'none'`, `connect-src 'none'`. It cannot read the parent DOM, cookies, storage, or the network. The worst a hostile artifact can do is draw the wrong pixels.
- **The application origin cannot eval at all.** Production CSP is `script-src 'self'` — no `'unsafe-eval'`. Moving execution into the sandbox removed the last `new Function` from the app; Babel parses and prints but never evaluates. The only document that can eval is the one with nothing to steal.
- **Sessions are httpOnly cookies**, `SameSite=Strict`, 12-hour expiry, unreadable by page scripts.
- **CSRF double-submit** on every cookie-authenticated mutating request, compared in constant time. Bearer-authenticated API clients are exempt, since those requests are not forgeable cross-origin.
- **Every decision is audited.** Fills, refusals, authorisation denials, vault edits and failed logins are appended to a hash-chained log before the response is sent. `/api/health` verifies the chain and reports `degraded` if it is broken, so an uptime monitor pages on tampering.
- **Model endpoints are authenticated and rate limited** (20/min). They spend your API budget.
- **Every settlement instruction is re-evaluated server-side** and returns `409` with the engine's reasoning when it refuses.
- **Passwords**: bcrypt cost 12, 12-character minimum, and a constant-time comparison against a dummy hash for unknown accounts so response timing does not reveal whether an account exists.

### Known limits

- Bids are modelled, not observed from real counterparties. Every surface that shows them says so. Connecting the ledger to the actual production-node graph from the specification is the next substantive piece of work, not another adapter.
- Rate limits and the kill switch are per-process and in-memory. Behind more than one instance, move them to Redis and a shared flag.
- The audit chain makes tampering *detectable*, not *impossible*. Anyone with write access to the database can still rewrite history; they cannot do it without breaking the chain. For stronger guarantees, ship chain heads off-box.
- The sandbox iframe is same-site but opaque-origin. A separate origin (a distinct hostname) would additionally defeat same-site cookie attacks; worth doing before third-party artifacts are shared between accounts.
- Rate limits are per-process and in-memory. Behind more than one instance, move them to Redis.
