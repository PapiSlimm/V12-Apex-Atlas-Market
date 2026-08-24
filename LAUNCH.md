# Launch readiness — go / no-go

You said ready to launch. I ran a hostile audit rather than a rubber stamp, and it found twenty-five things. Fourteen are fixed. Here is what can go out, what cannot, and what only you can do.

---

## The verdict

| Launch shape | Verdict | Why |
| --- | --- | --- |
| **Private beta / waitlist, free** | **GO** | Zero blockers. Security posture, tenancy isolation and the audit chain all verify clean against Postgres. |
| **Public free tier** | **GO, with one caveat** | Same, but the free tier has no server-side inference cap. One enthusiastic user can spend your API budget. |
| **Paid** | **NO-GO** | Nothing takes payment, and inference spend per account is not measured. You would be charging against a margin you cannot calculate. |
| **Enterprise / regulated buyer** | **NO-GO** | Not because of safety — because most of the specified product does not exist yet. See "What you are actually launching". |

---

## What the audit found

The one with a runtime consequence, first.

### A paying customer was locked out of the product

`PLAN_DEFAULTS` carried `tradingEnabled: false` for the free and $49 Professional tiers. A Professional customer placing an instruction got:

```
402  The professional plan does not include trade execution.
     code: trading_not_entitled
```

Two problems. It blocked a paying customer from the application's central workflow, and it cited a capability the product does not have. This came from `PRICING.md`'s recommendation to gate "trade execution" at Business and above — advice I wrote when I believed this was a financial platform. **The advice was wrong and it had shipped.**

Fixed: the entitlement is `assetLedgerEnabled`, it is on for every plan, and the 402 message is truthful. The mechanism is kept — it is the right seam for a future suspended or read-only plan — but nothing about booking your own inventory is risk-gated. Scale is gated by seats and inference credit, where the cost actually is. `PRICING.md` now carries the correction rather than a quiet deletion.

### Four screens were showing invented data as real

This is the same class of defect the original Stage 1 audit found and fixed for the Revenue Boardroom. It was never applied to the rest:

| Screen | Was | Now |
| --- | --- | --- |
| **Resource Monitor** | A browser-side random walk labelled **"D3 LIVE"**, beside "16 Cores / 3.8GHz", "64GB" and "24GB VRAM H100" — a card that does not exist at that memory size | An amber disclosure, "SAMPLE", and the invented hardware strings gone |
| **Synchronizer** | `SHA3-${crypto.randomBytes(4)}` rendered as **"Cryptographic Proof"** beside a shield icon | The tenant's real audit chain head — a SHA-256 over real entries, verified on read |
| **Command Center** | "GLM-5.2 + MoL Active", "blends token embeddings across LoRA adapters" | "Routing gate · heuristic", and an honest description of what the keyword scorer does |
| **Re-index command** | A 2-second `setTimeout` that then asserted *"Digital twin graph is consistent"* — a factual claim about your data that nothing checked | Calls the real structural validator and reports its actual error and warning counts |

The fake proof was the worst of them. Four random bytes beside a shield devalue the genuine guarantee this system has, and a security reviewer who finds it stops trusting everything else.

### The documented quickstart did not work

`DEPLOYMENT.md` says `cp .env.example .env`, set `JWT_SECRET` and `POSTGRES_PASSWORD`, `docker compose up -d`. `.env.example` had no `POSTGRES_PASSWORD` key — compose aborts. It was also missing `MULTI_TENANT`, `DEFAULT_TENANT_NAME`, `DEFAULT_TENANT_PLAN` and all five `RISK_*` variables that the server genuinely reads. Fixed.

### Documents that would have misled a buyer

- `README.md` called the ledger "the real trading surface" with "live quotes", named "trading and treasury desks" as an audience, and said the system is "safe enough to point at real money". All corrected.
- `SCOPE.md` and `EXECUTION.md` read as the live roadmap — crypto instruments, a broker adapter, `EXECUTION_MODE=live`. They are dated design records of a withdrawn proposal. I did **not** rewrite them; falsifying the record is worse. Each now opens with a **superseded** banner.
- `metadata.json` — the one-line description a marketplace listing renders — claimed "full-scale enterprise" of a product that is 10–15% built. Rewritten.
- `desktop/README.md` pointed at an `ARCHITECTURE.md`, a `tauri.conf.json` and a `package.json` that do not exist, with build commands that cannot run.
- `SecurityAuth` claimed to mirror the server's role guards "so the UI cannot drift". It had already drifted — four capabilities listed against ten guards, with the kill switch, reconciliation and audit-log access missing. Added, and the comment now says the truth: it is maintained by hand.

### Smaller, fixed

Exported snapshots stamped `v12.4.0-APEX` against a `12.5.0` package (now stamped at build time from `package.json`); "24/7" badges implying a scheduler that does not exist; a preflight blocker citing a README section that was never written; stale counts in the README.

---

## Verification, on the path a real launch takes

Everything below ran against a **cold Postgres instance in `NODE_ENV=production` with `MULTI_TENANT=true`** — the cloud configuration, not the SQLite dev default.

| Suite | Result |
| --- | --- |
| `npm run lint` | clean |
| `npm test` | **149 / 149** |
| `scripts/verify.mjs` | **86 / 86** |
| `scripts/verify-tenancy.ts` (Postgres, multi-tenant) | **16 / 16** |
| `scripts/preflight.ts` (Postgres, production) | **11 passed · 3 warnings · 0 blockers** |

**The Docker image is still unbuilt.** There is a Docker CLI here but no daemon, and that has not changed. What I could verify, I did: `npm ci`, `npm run build`, and a cold production boot against real Postgres with the full isolation probe green. The commands inside the Dockerfile are exercised; the image itself is not. Build it once before you rely on it.

---

## What you are actually launching

Being plain about this, because it determines who you can put in front of it.

**Solid and verified:** authentication and sessions, RBAC, multi-tenant isolation enforced by the type system, the hash-chained audit log, the sandboxed generative-UI harness, the Hermes mandate engine, the digital twin with its structural validator, the asset ledger, and a design system with real accessibility guarantees.

**Not built:** most of specification pp. 28–32. No Agent Factory, no Agent Warehouse, no Workflow Builder, no Mission Control, no City World, no Analytics, no Billing. Nine of fourteen component families; roughly 10–15% of the specified surface.

That is a **credible private beta**, not an enterprise sale.

---

## Deploy sequence

```bash
# 1. Secrets — from a secret manager, not a file
openssl rand -hex 32          # JWT_SECRET
openssl rand -hex 24          # POSTGRES_PASSWORD

# 2. Configure
cp .env.example .env          # every required key is now present
#    JWT_SECRET, POSTGRES_PASSWORD, DATABASE_URL
#    MULTI_TENANT=true for cloud; leave unset for self-hosted
#    ENABLE_DEMO_USERS must stay UNSET

# 3. Build the image once, on a machine with a daemon
docker build -t apex-atlas:12.5.0 .

# 4. Deploy behind TLS you terminate upstream
docker compose up -d

# 5. Gate the release on these three, in order
npm run preflight https://your-deployment    # must report 0 blockers
npm run verify:tenancy https://your-deployment
node scripts/verify.mjs https://your-deployment
```

Then wire `/api/health` to your alerting **including the `degraded` state** — it verifies every tenant's audit chain on each call, so an uptime monitor pages on database tampering, not merely on a dead port.

---

## Decisions only you can make

1. **Launch shape.** Waitlist, open free tier, or invite-only beta. This determines whether the missing inference cap matters on day one.
2. **Where it runs.** Any container host works. Postgres must be managed, with a backup you have restored at least once.
3. **The domain**, and TLS at the terminator.
4. **The marketing site — a separate host.** The app carries `noindex` and `robots.txt` disallows everything, deliberately: indexing an app host is how customer subdomains end up in search results. Do not undo this to get SEO.

## Before you charge anyone

Three things, in order, and none of them are safety:

1. **Usage metering.** Inference spend per account. Without it every price is a guess — including the ones in `PRICING.md`.
2. **Billing.** Seats and entitlements are enforced server-side; nothing takes payment.
3. **Redis for rate limits and the kill switch.** They are per-process today. Two instances means two independent limiters and a halt that stops only one of them. This is the sharpest edge in the build and it only bites when you scale out.

---

## My recommendation

Launch a **closed beta, free, single region, one instance, invite-only**, with a hard manual cap on invites while there is no metering.

That configuration has zero blockers, exercises the parts that are genuinely production-grade, and puts the product in front of people whose feedback should shape the nine modules that do not exist yet — before you build them on assumptions rather than evidence.

The thing I would not do is sell this as the enterprise platform the specification describes. Not because the foundation is weak — it is the strongest part of the work — but because a buyer expecting 90 pages and 14 modules will find 8, and that conversation is much harder to recover from than a beta that under-promised.
