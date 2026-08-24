# Stage 3 — Live Market Data & Execution

> **Superseded — historical record. Do not implement.**
> This document proposed an external broker/exchange integration for a product
> that has no external settlement. The proposal was withdrawn; see
> `RECONCILIATION.md` and `EXCISION.md`. `EXECUTION_MODE`, `VENUE`, paper/live
> modes and the venue adapter described below do not exist and will not be
> built. Test counts quoted here were correct at the time and are deliberately
> not updated.


Scope and design for replacing the simulator with a real price feed and a real broker, and replacing whole-position liquidation with a proper order lifecycle.

---

## The problem in one paragraph

Today an "asset" is a row with a `quantity` and a `current_price`, and executing a trade means setting `quantity = 0`. That model has no orders, no fills, no venue, no rejections, no partial execution, and no concept of an instruction that is *in flight*. It cannot express "I asked to sell 1,420 units, 900 filled at 16.81, 520 are still working, and then the process crashed." Every real execution system exists to answer that question, and ours currently cannot form the sentence.

So this stage is not "plug in an API". It is replacing a settlement-by-assignment model with a ledger.

---

## What changes conceptually

| Today | After |
| --- | --- |
| `asset.quantity = 0` | An **order** is placed; **fills** arrive over time; **position** is derived from fills |
| Price is a column | Price is a **quote** from a data source, with an age and a staleness policy |
| Execute-or-refuse | Place, partially fill, amend, cancel, reject, expire |
| One decision, one moment | A decision produces a **plan**; the plan produces orders; orders produce fills |
| Crash = lost intent | Crash = **reconcile** against the venue on boot |
| Whole position | **Sized** orders under risk limits |

The Hermes engine keeps its job — deciding whether an action is permitted — but its output becomes an `ExecutionPlan` (side, quantity, limit price, time-in-force) rather than a verdict on the whole position.

---

## The two interfaces

Everything venue-specific hides behind these. The same pattern as `Store`: one contract, multiple implementations, one conformance suite both must pass.

```ts
interface MarketDataSource {
  readonly id: string;
  quote(symbol: string): Promise<Quote | null>;        // snapshot
  subscribe(symbols: string[], cb: (q: Quote) => void): Unsubscribe;
  readonly capabilities: { streaming: boolean; depth: boolean };
}

interface ExecutionVenue {
  readonly id: string;
  readonly mode: 'paper' | 'live';
  place(intent: OrderIntent): Promise<PlacedOrder>;    // idempotent on clientOrderId
  cancel(clientOrderId: string): Promise<CancelResult>;
  get(clientOrderId: string): Promise<VenueOrder | null>;
  openOrders(): Promise<VenueOrder[]>;                 // for reconciliation
  fillsSince(cursor: string | null): Promise<{ fills: VenueFill[]; cursor: string }>;
}
```

Three things in there matter more than the rest:

**`clientOrderId` is an idempotency key.** We generate it, persist it *before* calling the venue, and the venue must treat a repeat as the same order. Without this, a timeout on `place()` is unresolvable: you cannot know whether the order exists, and retrying might double it. This is the single most important detail in the whole design.

**`fillsSince(cursor)`** is a pull-based catch-up path, not just a stream. Streams drop. After any disconnect or restart we replay from the last cursor rather than hoping we saw everything.

**`mode: 'paper' | 'live'`** is on the interface, not in config, so it can be surfaced in the UI, stamped on every order, and asserted in tests. A paper adapter and a live adapter are different objects, not the same object with a flag someone might mis-set.

---

## Phases

### Phase 1 — The ledger (venue-independent)

Nothing here talks to a network. It is the model everything else needs.

- `Instrument`, `Quote`, `Order`, `Fill`, `Position` types; tick size, lot size, fee schedule.
- Position accounting from fills: weighted-average cost basis, realised and unrealised P&L, fees capitalised on the buy leg and expensed on the sell leg.
- Order state machine: `pending → working → (partially_filled) → filled | cancelled | rejected | expired`, with only legal transitions permitted.
- `orders` and `fills` tables in both backends; position derived, never stored as truth.
- Hermes extended to emit `ExecutionPlan` with a size.
- Position sizing and risk limits: max order notional, max daily notional, max position concentration, and a global kill switch.

**Why first:** it is the part that must be right, it is fully testable without a venue, and every later phase depends on it. Fixing a cost-basis bug after real fills are in the database is a data-migration problem, not a code problem.

### Phase 2 — Simulated venue behind the real interface

The current simulator is hardcoded into route handlers. It becomes a proper `ExecutionVenue` that behaves like a bad venue on purpose: partial fills, variable latency, occasional rejections, occasional silence.

**Why this matters more than it sounds:** most execution bugs are handling bugs, not happy-path bugs. A simulator that always fills instantly and completely tests nothing. This one is where we prove the reconciliation and idempotency paths work, before a real venue is on the other end with real money.

### Phase 3 — Reconciliation and crash recovery

On boot, and after any venue disconnect: fetch open orders, replay fills from the stored cursor, and diff against local state. Any disagreement is an audit event and, if material, halts trading rather than guessing.

Deliberately includes a test that kills the process mid-order and asserts the ledger converges on restart. That is the test that tells you whether the design is real.

### Phase 4 — Live market data

A `MarketDataSource` against a real feed, plus the policy layer around it: quote staleness thresholds, a circuit breaker that refuses to trade on prices older than *N* seconds, and a sanity band that rejects quotes deviating implausibly from the last known good price. Bad data has caused more trading losses than bad logic.

### Phase 5 — Live venue adapter

One concrete broker or exchange, paper mode first, gated behind an explicit `EXECUTION_MODE=live` plus a per-instrument allowlist plus a max-notional ceiling. Live mode should be tedious to enable on purpose.

### Phase 6 — Operator surface

Order ticket, working orders blotter, fills, position and P&L, kill switch in the header. The kill switch belongs somewhere an operator can hit it in one click from any screen.

---

## Decisions I need from you

**1. Which venue, and which asset class?** This is the one genuinely blocking item, and only for Phase 5 — everything before it is venue-agnostic. It changes the reference adapter, the instrument model (crypto has 8 decimals and no lot size; equities have lots, settlement dates and market hours), and the compliance surface.

I noticed a **Revolut X** connector in your environment, which suggests crypto. If that's the target, say so and I'll write that adapter; the instrument model gets simpler and there are no market-hours edge cases.

**2. Paper-only, or a path to live?** If live is ever in scope, Phase 1 needs an extra piece now: a reconciliation ledger that can prove, from the audit chain alone, what the system believed and when. Retrofitting that is painful.

**3. Multi-tenant?** Right now positions are global — everyone sees the same book. If accounts should have their own books, that ownership key belongs in the schema in Phase 1, not later.

Defaults if you'd rather not decide: crypto-shaped instruments, paper-only with the live seam built but no live adapter, single-tenant. I'll proceed on those unless told otherwise.

---

## Risks worth naming

**The one that actually bites: partial fills and cost basis.** Sell 900 of 1,420 units and the remaining 520 keep the original basis, while the realised P&L on the 900 is computed against that basis net of the fees attributable to *those* units. Getting the fee apportionment wrong produces P&L that looks plausible and is wrong — the same failure mode as the original `(current - acquisition) * quantity` bug, just harder to spot. Mitigation: property-based tests asserting that realised + unrealised + fees always reconciles to cash flows, across randomised fill sequences.

**Timeouts on place().** Covered by `clientOrderId` idempotency, but the code path needs to be written for it deliberately: persist intent, call venue, and on timeout, query rather than retry blindly.

**Clock skew.** Venue timestamps and ours will disagree. Ordering by our clock creates fills that appear to precede their orders. Store both; order by venue sequence where available.

**Scope creep into an OMS.** This design stops at single-venue, single-strategy, whole-order execution. No smart routing, no child orders, no algos. Those are a different product.

---

## Effort

| Phase | Size | Depends on |
| --- | --- | --- |
| 1 — Ledger | Large | — |
| 2 — Simulated venue | Medium | 1 |
| 3 — Reconciliation | Medium | 1, 2 |
| 4 — Market data | Medium | 1 |
| 5 — Live adapter | Medium | 1–4, plus your venue decision |
| 6 — Operator surface | Medium | 1–3 |

Phases 1–3 are the substance and are fully verifiable with no external dependency. That is where I'd spend the effort, and it is what I am starting on now.
