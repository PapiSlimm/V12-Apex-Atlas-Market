# Excision — removing the exchange layer

Step 1 of the plan in `RECONCILIATION.md`. The financial-exchange integration is gone and the asset layer now speaks the specification's own language.

---

## What was deleted

| File | Lines | Why |
| --- | --- | --- |
| `server/market/revolutx.ts` | 658 | Crypto-exchange wire adapter. Nothing in 32 pages of specification asks for one. |
| `tests/revolutx.test.ts` | 531 | Tested the above. |
| `tests/venue-conformance.ts` | 226 | A shared conformance suite only earns its keep with two implementations. There is now one, and it is internal. |
| `scripts/verify-venue.ts` | 191 | Read-only probe against a live brokerage account. |
| `VENUE-REVOLUTX.md` | — | The adapter's design report. |

**1,606 lines removed.** Also gone: `VENUE`, `EXECUTION_MODE`, `REVOLUTX_*`, `RISK_LIVE_ALLOWLIST`, `SIM_BEHAVIOUR`, the `npm run verify:venue` script, and the `paper`/`live` mode distinction throughout.

Test count moved from 134 to 94. That is not a regression — 40 of the deleted tests existed to prove an exchange adapter was correct. Every remaining test passes, and coverage of the ledger, the store, tenancy and the audit chain is unchanged.

## What was renamed

`server/market/` is now `server/assets/`, and the nouns are the specification's:

| Was | Is |
| --- | --- |
| `ExecutionVenue` | `Marketplace` |
| `MarketDataSource` | `BidFeed` |
| `SimulatedVenue` | `InternalMarketplace` |
| `Instrument` | `AssetSpec` |
| `symbol` | `assetId` |
| `tick_size` / `lot_size` / `min_quantity` | `price_increment` / `block_size` / `min_blocks` |
| `startTradingRuntime` | `startAssetRuntime` |
| "Execution Desk" | "Asset Ledger" |

Database column names were deliberately **left alone**. Renaming `symbol` to `asset_id` in SQL would have required a second migration path for zero user-visible benefit; the mapping happens in `sql-store.ts`, in the four places that already translate rows into objects.

## Two behaviour changes, not just renames

**1. The fundamental invalidation breaker now actually fires.**

Specification §4 says a structural-integrity failure on a production line should force liquidation. The check existed — and was gated behind `ctx.mode === 'live'`, a mode nothing ever ran in. It was dead code wearing the costume of a safety control.

It is now unconditional and scoped correctly: **acquisition is blocked** when `fundamentals_intact` is false; **liquidation stays permitted**, because the whole point of the breaker is to let you get out.

**2. Preflight blocks on a foreign marketplace.**

```
BLOCKER  A non-internal marketplace adapter is active
         Apex Atlas settles media assets internally and has no external exchange integration
```

The mistake this repository just spent a day undoing was one I could make again. A check that fails the deploy is a stronger guarantee than a note in a README.

## What was kept, and why it was always right

`ledger.ts`, `execution.ts`, `risk.ts` and `strategy.ts` stayed. Fills, weighted-average cost, realised P&L, idempotency keys and reconciliation are not exchange concepts — they are what any system tracking "we acquired 1,420 blocks at $12.50 and sold some at $16.80" needs to get right. The 2,000-seed property test that found a rounding bug in the cost basis is as valuable for H.266 blocks as it was for anything else.

`server/hermes.ts` was never touched. It already matches the specification's `HermesProfitAgent` line for line.

## Verification

| Suite | Result |
| --- | --- |
| `npm run lint` (tsc strict) | clean |
| `npm test` | **94 / 94** |
| `scripts/verify.mjs` (browser) | **62 / 62** |
| `scripts/verify-tenancy.ts` (HTTP isolation) | **15 / 15** |
| `scripts/preflight.ts` | 9 passed · 4 warnings · **0 blockers** |

The browser suite caught two things worth recording. Renaming the halt toast to match the halt banner made the strings identical, and Playwright's strict mode refused a locator that matched both — a real ambiguity, fixed by making the toast say "Kill switch engaged". And the ledger UI's own asserts caught that `/api/execution/state` had been renaming `instrument` to `spec` while the verification script still read the old key.

## Still outstanding

- **`PRICING.md` line 69** still sells "paper mode" as a free tier feature and reasons about the liability of touching a real market. That framing is now wrong. It is deliberately left for step 5 rather than patched, because pricing should follow from what the product is, not be edited to match a rename.
- **`EXECUTION.md`** keeps its original text, including the line where I proposed the Revolut X adapter. It is a dated report of what happened and editing it would be tidying the record rather than correcting it.
- **Steps 2–5** of `RECONCILIATION.md` are untouched: the real node schemas from pp. 17–20, the frontend platform decision, the design system, then pricing.
