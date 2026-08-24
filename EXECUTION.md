# Stage 3, Phase 1–3 — The Execution Ledger

> **Superseded — historical record. Do not implement.**
> This document proposed an external broker/exchange integration for a product
> that has no external settlement. The proposal was withdrawn; see
> `RECONCILIATION.md` and `EXCISION.md`. `EXECUTION_MODE`, `VENUE`, paper/live
> modes and the venue adapter described below do not exist and will not be
> built. Test counts quoted here were correct at the time and are deliberately
> not updated.


Delivered against `SCOPE.md`. Phases 1 (ledger), 2 (simulated venue behind the real interface) and 3 (reconciliation) are complete and verified. Phases 4–6 (live market data, live venue adapter, full operator blotter) remain, and phase 5 still needs your venue decision.

**Verified:** 83 unit tests, store conformance passing on both SQLite and Postgres, 62 browser checks against the production build.

---

## What changed

The old model could not form the sentence *"I asked to sell 1,420 units, 900 filled at 16.81, 520 are still working, and then the process crashed."* An asset was a row with a `quantity`; executing meant setting it to zero. There were no orders, no fills, no rejections, and no concept of an instruction in flight.

There is now a ledger.

| Before | Now |
| --- | --- |
| `asset.quantity = 0` | An order is placed; fills arrive over time; the position is *derived* from fills |
| Price is a column | A quote with an age, a staleness gate and a sanity band |
| Execute-or-refuse | pending → working → partially filled → filled / cancelled / rejected / expired |
| One decision, one moment | A decision produces a **sized plan**; the plan produces orders; orders produce fills |
| Crash = lost intent | Crash = reconcile against the venue on boot |
| Whole position | Sized orders under enforced risk limits |

---

## The invariant that holds it together

A position is never stored as truth. Storing a position *and* the fills that produced it means two sources that will disagree, and the disagreement always surfaces as money that does not add up. So the position is folded from an ordered fill sequence, and one identity holds at every point in it:

```
realisedPnl − quantity × averageCost === cashFlow
```

That ties the three numbers a trader cares about to the cash that actually moved. It holds for longs, for shorts, and across a position that crosses through zero in a single fill.

`tests/ledger.test.ts` asserts it **after every fill across 2,000 randomised sequences**, seeded so any failure is reproducible. Worked examples catch the cases you thought of; the property catches the ones you did not — which, for fee apportionment across partial fills, is where the bugs actually live.

### It immediately caught something

The first run failed on seed 1,486: a 115-unit position drifted **1.01e-6** out of balance. Not a logic error — I was rounding `averageCost` to 8 decimal places. That injects up to 5e-9 of error *per unit*, which a large position multiplies into something visible.

The fix is a distinction worth stating: `averageCost` is a derived **ratio**, not an amount that moves, so it is now carried at full precision. Only quantities corresponding to real cash — `cashFlow`, `realisedPnl`, `feesPaid` — are rounded. The tolerance also became relative as well as absolute, because a fixed 1e-6 epsilon is generous on a $100 position and impossibly strict on a $100M one.

This is exactly the class of bug that produced the original `(current_price − acquisition_price) × quantity` error: plausible numbers that are wrong. The difference is that this one was caught by a test in the first minute rather than by a user reading a P&L statement.

---

## `clientOrderId`: the most important detail

The order row is persisted **before** the venue is called. Then:

- **`place()` succeeds** → update with the venue's id and status.
- **`place()` throws** → query the venue by `clientOrderId`. Do **not** resubmit. If the venue has it, adopt it. If the venue has never heard of it, mark it rejected.
- **The query also fails** → leave it `pending` — the one status that means *we do not know* — and let reconciliation resolve it. Marking it rejected here would be a lie that could orphan a live position.

A blind retry after a timeout is how one intent becomes two positions. Idempotency turns an unanswerable question into a safe repeat. All three branches have tests; the simulator reproduces the hard one by recording the order and *then* throwing, exactly as a real venue timeout after acceptance does.

---

## The simulator is hostile on purpose

A simulator that always fills instantly and completely tests almost nothing, because most execution bugs are handling bugs. This one partially fills, delays, rejects outright, stalls indefinitely, and drops connections after accepting an order. Everything random runs off a seeded PRNG, so a failure is reproducible rather than a flake.

That is what makes the reconciliation and idempotency paths meaningful before real money is on the other side.

The suite includes a 40-order run against the hostile profile that asserts, afterwards, that the books still balance, every order's aggregate matches the sum of its own fills, and no order ever overfilled.

---

## Reconciliation and crash recovery

On boot and on demand: replay fills from a stored cursor, pull open orders, diff against local state.

- Fills are idempotent on `venueFillId`, so overlapping push and pull delivery is harmless rather than double-counted.
- A `pending` order the venue never received is resolved to `rejected` — it never landed.
- A *working* order the venue has lost is a **discrepancy**, reported and not patched. Material discrepancies halt trading on boot. An unexplained divergence between our book and the venue's is precisely the condition where guessing makes things worse.

The test that says whether the design is real: place an order, let one tranche fill, throw away the service as if the process died, let the rest fill while "down", then start a new service against the same database and venue. It asserts the missed fills are replayed, the order reaches `filled`, and the ledger balances.

---

## Sized plans

Hermes keeps its job — deciding whether an action is permitted — but emits an `ExecutionPlan` with a **size**, a limit price, and a time-in-force. Three details worth noting:

- **Sells mark against the bid**, not the mid and not the last trade. Marking a plan at a price you cannot transact at is how a strategy looks profitable in backtest and is not in production.
- **Scale-out with a stub guard.** The default takes 50% at the strike, but if the residual would fall below the venue minimum or 10% of the position, it takes the lot instead — so you never leave inventory you cannot sell.
- **Limit at the bid, not market.** Willing to take the current price, unwilling to chase it down if the book moves between decision and arrival.

---

## Risk controls

Every order passes `assess()` before reaching a venue: order notional, rolling daily notional, projected position concentration, quote staleness, crossed quotes, price-deviation sanity band, lot size, venue minimum, and in live mode a per-symbol allowlist.

All checks are **refusals**. Nothing resizes an order to make it acceptable — a risk layer that silently resizes is one nobody can reason about: the operator asked for one thing, the venue got another, and the audit log has to explain a number nobody chose.

Every failed check is returned, not just the first; an operator fixing one wants to see the rest. Verified in-browser: an oversized order comes back `409` naming `max_order_notional`, `max_daily_notional` and `max_position_notional` together.

The **kill switch** is checked first and is not overridable by anything below it. Halting is available to any trading role; resuming needs Executive or System Admin. The UI banner is impossible to miss, and `/api/health` reports `degraded` while halted so an uptime monitor notices.

---

## Verification

```
npm run lint    → clean (strict)
npm test        → 83/83   (ledger property tests, execution, store, chain, engine, compiler)
TEST_DATABASE_URL=… npm test
                → 38/38   (store conformance on Postgres too)
npm run build   → dist/client + repl-sandbox.js + dist/server.cjs
verify.mjs      → 62/62   against the production build
```

Browser-verified end to end: order accepted → fills arrive → position built with a fee-inclusive basis → the ledger invariant checked *through the API* → oversized order refused with named limits → kill switch blocks execution → resume clears it.

---

## What's left, and the decision I still need

**Phase 4 — live market data.** A `MarketDataSource` against a real feed. The policy layer around it (staleness gate, sanity band) already exists and is enforced; it just needs a real feed behind it.

**Phase 5 — live venue adapter.** Blocked on one question: **which venue and asset class?** Everything to here is venue-agnostic, so this is the only decision that gates anything. It changes the instrument model — crypto has 8 decimals and no lot size or market hours; equities have lots, settlement and sessions — and the compliance surface.

I noticed a **Revolut X** connector in your environment, which points at crypto. If that is the target, say so and I will write that adapter next; the instrument model gets simpler and the market-hours edge cases disappear.

**Phase 6 — operator blotter.** The desk covers quotes, positions, working orders, fills and the kill switch. A full blotter (order history filtering, per-fill drill-down, P&L attribution) is the remaining polish.

Also still open from the scope: **paper-only or a path to live** (affects whether the audit chain needs to prove system belief-state, which is painful to retrofit), and **multi-tenant** (the ownership key belongs in the schema now, not later, if accounts should have separate books).
