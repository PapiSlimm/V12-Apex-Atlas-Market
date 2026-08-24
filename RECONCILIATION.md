# Reconciliation — the spec vs. what I built

I have now read all 32 pages of `V12_APEX_ATLAS_2.pdf`. This document says what the spec actually asks for, what I built instead, what survives, and what has to go. No proposals until the record is straight.

---

## 1. What Apex Atlas actually is

**An Agentic Operating System (AIOS) for a multimedia production business.**

The spec builds up in three layers:

1. **Pages 1–7 — the vault.** Claude Code plus an Obsidian markdown vault as a "memory galaxy": `00_Capture/`, `10_Active/`, `20_Resources/`, `30_System/`, `40_AI_Archive/`, driven by slash commands (`/day`, `/brief`, `/resume`, `/wrap-up`). Scaled up into a `/Company-Galaxy-OS` and then a `/Global-Supply-Galaxy` digital twin: Geographic Hubs → Production Nodes → Logistics Nodes.
2. **Pages 8–27 — the engine.** Macaron-v1: an LO (Local-Optima) Routing Agent on a GLM-5.2 + Mixture-of-LoRAs substrate, dispatching to CHAT / CODE / GenUI / ASSET TRADER specialists, over MCP into that vault. Hermes agents run **multimedia product arbitrage** under a zero-loss mandate.
3. **Pages 28–32 — the build brief.** A Next.js 15 + Turborepo + pnpm monorepo, a "Glass Panels / Quantum Cards" design system, an AIOS shell, 14 enterprise modules, 450+ components, 90+ pages, Three.js visualisations, and a separate marketing landing page.

### The thing I got wrong, stated plainly

The spec's "trading" is **agents buying and selling the digital media assets your own factories produce**. Page 20 is unambiguous about the inventory:

```
asset_class: H266_Video_NFT
quantity: 1420
base_acquisition_cost_per_unit: 12.50
current_market_bid_floor: 14.10
```

and the production line that makes them:

```
line_id: L1-VideoRender    max_throughput_fps: 24000
line_id: L2-AudioSynth     max_throughput_hz: 192000
```

That is an **internal media-asset economy** with a profit floor. It is not a public financial market, and there is no exchange in it. I built a crypto-exchange execution stack — a Revolut X wire adapter, venue conformance suites, live-trading gates, notional ceilings. **That came from me, not from you**, and it is why "APEX IS NOT A TRADING APP" was the correct correction.

---

## 2. Where the spec and my build actually line up

Some of the work maps cleanly. This is not consolation — it is the part that should survive untouched.

| Spec | What exists | Verdict |
| --- | --- | --- |
| `HermesProfitAgent` (pp. 22–24): 15% stop-loss, 30% profit target, net-yield-after-fees gate, fundamental invalidation breaker | `server/hermes.ts` — `evaluateAsset`, `authoriseSell`, `netYieldPerUnit` | **Direct match.** Same rules, same thresholds, with tests. |
| Compulsory Arbitrage Execution Rule: block the exit unless Δπ ≥ 0 (p. 21) | `authoriseSell` refuses a non-positive net yield | **Direct match.** |
| UI4A REPL Harness / GenUI Mini-App Vector Blocks (pp. 19–21) | `UI4AReplHarness.tsx`, `SandboxedArtifact.tsx`, `compileArtifact.ts`, `/repl-sandbox` | **Match, and safer than the spec.** The spec's own listing uses `new Function` on model output in the parent page. I replaced that with Babel transpilation plus an opaque-origin iframe with `connect-src 'none'`. The spec as written would let generated code read your session cookie. |
| "Automated Audit Trails" (p. 6); "SHA-3 / post-quantum proofs signed" (p. 26) | Hash-chained append-only audit log, verified per tenant on every health check | **Match in substance.** SHA-256 not SHA-3; the chain and verification are real. |
| Digital twin: Geographic Hubs / Production Nodes / Logistics Nodes | Seed graph + `MemoryGalaxyGraph.tsx` | **Partial.** The node model exists; the frontmatter schema from pp. 17–20 does not. |
| "Organizations" module (p. 31) | Multi-tenancy with compiler-enforced isolation, 15/15 isolation probe | **Match, ahead of schedule.** |
| Docker, CI, tests, deployment docs (pp. 29–30) | `Dockerfile`, `docker-compose.yml`, 134 tests, `preflight.ts` | **Match.** |
| Revenue Kit Profit Boardroom dashboard (pp. 25–26) | `RevenueBoardroom.tsx` | **Shell only** — it renders, it isn't wired to a real asset book. |

---

## 3. Where I built the wrong thing

| Artefact | Why it is wrong | Recommendation |
| --- | --- | --- |
| `server/market/revolutx.ts` | A wire adapter for a crypto exchange. Nothing in 32 pages asks for one. | **Delete.** |
| `server/market/venue.ts`, `simulated.ts`, `tests/venue-conformance.ts`, `scripts/verify-venue.ts` | The abstraction exists only to talk to external exchanges. | **Delete.** |
| `EXECUTION_MODE`, `VENUE`, `RISK_MAX_ORDER_NOTIONAL`, the live-trading gates in `preflight.ts` and `DEPLOYMENT.md` | Guardrails around a capability the product should not have. | **Delete.** |
| `ExecutionDesk.tsx` | Framed as a trading desk with symbols and order types. | **Rewrite** as the Asset Ledger view over media inventory — same data shape, correct nouns. |
| `PRICING.md` | Its whole risk framing assumed a platform that moves customer money. | **Rewrite.** The liability profile of a media-ops workspace is ordinary SaaS. |
| `server/market/ledger.ts`, `execution.ts`, `risk.ts`, `strategy.ts` | **Not wrong — mis-aimed.** The arbitrage loop genuinely needs fills, average cost, realised P&L and a kill switch. Those apply to H266 blocks as readily as to anything else. | **Keep, rename, re-point** at the asset classes on p. 20. The 2000-seed property test keeps its value. |

Deleting the venue layer removes roughly 1,400 lines and three verification suites. I would rather carry that loss now than ship an exchange integration inside a media OS.

---

## 4. The gap nobody has looked at yet

Pages 28–32 are the actual build brief, and I have not touched most of it. Measured honestly:

| Spec asks for | Exists today |
| --- | --- |
| Next.js 15 + Turborepo + pnpm monorepo | Vite SPA, single package |
| 450+ reusable components | 17 |
| 90+ enterprise pages | 1 shell with panels |
| 14 enterprise modules | ~4 partial |
| Design system (Glass Panels, Quantum Cards, motion, Storybook) | Tailwind utilities, no system, no Storybook |
| Three.js / React Three Fiber "City World" | d3 force graph |
| LO Routing Agent (MoL specialist routing) | Single Gemini call, no router |
| Agent Factory, Agent Warehouse, Workflow Builder, Mission Control | None |
| Analytics, Security Shield, Billing, Notifications | None |
| Marketing landing page | None (deliberately — app host carries `noindex`) |

**Not built** is the honest word for most of the product. What exists is a hardened spine: auth, tenancy, storage, audit chain, sandboxed GenUI, the Hermes rules engine, deployment. That spine is worth having and it is genuinely production-grade. It is perhaps 10–15% of the specified surface.

One judgement call flagged rather than made: the spec names **Next.js 15 + Turborepo + pnpm**, and I built Vite + Express. Migrating is real work — the server, the sandbox route and the CSP all move — but it gets cheaper the earlier it happens, and it is the difference between following your brief and quietly substituting my own.

---

## 5. What I recommend, in order

1. **Excise the venue layer.** Delete the exchange code, re-point the ledger at media asset classes, rename the desk. Roughly half a day, and it stops the product describing itself wrongly.
2. **Model the real inventory.** Implement the frontmatter schemas from pp. 17–20 — `factory_node`, `warehouse_node`, `geographic_hub`, `allocated_inventory_blocks` — as the actual store schema. Wire the Revenue Boardroom to it so the numbers on screen come from the book.
3. **Decide the frontend platform before building 450 components.** Next.js 15 + Turborepo per the spec, or a documented, reasoned deviation. This is the single most expensive decision left and it should not be made by default.
4. **Then the design system**, then the modules in the spec's own order.
5. **Pricing and packaging last** — they follow from what the product turns out to be, and rewriting them before step 2 would just be guessing twice.

Nothing in the codebase has been deleted or changed. I am not touching `server/market/` or `PRICING.md` until you say so.
