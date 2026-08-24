# The digital twin, computed

Step 2 of `RECONCILIATION.md`. The supply network from specification pages 12–20 is now a typed, validated graph that the risk layer actually reads.

---

## What was wrong

The vault held the specification's node files verbatim — production lines, throughputs, marginal costs, warehouse capacities, inventory blocks. All of it was **text**. The only structured data the application could act on was a loose `metrics` bag that a human editing markdown in Obsidian would never think to update.

So the twin looked right and did nothing. The boardroom's headline figures were constants lifted from the specification's mock-up. `fundamentals_intact` — the flag the whole invalidation breaker turns on — was a boolean in a database column with no connection to whether any production line was actually running.

## What it is now

`server/twin/` parses the frontmatter into a typed graph on every request:

```
GeographicHub ──< FactoryNode ──< ProductionLine
                       │
                       └──> WarehouseNode ──< InventoryBlock
```

Nothing is cached and nothing is duplicated into its own tables. The vault is the source of truth, which is what the specification says and what a digital twin has to mean to be worth having. If this ever gets slow the fix is a cache keyed on the vault's last-modified timestamp — not a second copy of the data that can disagree with the markdown.

### The parse

`js-yaml` does the YAML. Hand-rolling a YAML subset is a well-known way to be subtly wrong about indentation and type coercion for years.

The one thing YAML does not know is Obsidian's `[[Wiki-Link]]`, which it sees as a nested flow sequence:

```
parent_hub: [[City-Detroit]]      ->  [['City-Detroit']]
downstream: [ [[A]], [[B]] ]      ->  [[['A']], [['B']]]
```

A link and a list of links differ only in nesting depth, so both collapse correctly under a deep flatten. That is the whole trick, and it is tested directly because getting it wrong would make every relationship in the graph wrong.

**Parsing never throws.** A file with broken frontmatter becomes one reported issue on one node and every other file still parses. A vault edited by humans will contain broken files; that is the normal case, not the exception.

## The three things this makes true

### 1. The boardroom computes

| Figure | Before | Now |
| --- | --- | --- |
| Ecosystem valuation | `$12,482,900.50` — from the mock-up | Σ quantity × bid across every warehouse |
| Buffer load | `42%` — from the mock-up | 1,420 blocks × 1.48 TB ÷ 5,000 TB = **42.03%** |
| Strike floor | text | acquisition × 1.30 = **$16.25** on the specification's own example |
| Net yield | text | bid × (1 − sellFee) − acquisition × (1 + buyFee) |

The 42% is worth dwelling on. It is the specification's own number, and it now arrives by arithmetic rather than by being typed in. That required adding one field the specification does not have — `block_size_tb` — because `storage_capacity_tb: 5000` says nothing about how full a site is unless a block has a weight. Where the data is missing, utilisation reports `null`, not `0%`. A warehouse that reads as empty because of an absent field is the worst possible way to be missing data.

### 2. The breaker reads the vault, at decision time

Mark `L1-VideoRender` as `degraded` in Obsidian and the next acquisition of `H266_Video_NFT` is refused — in the same request, not after a restart. The runtime's asset table is built once at boot; consulting that snapshot would leave the breaker blind for exactly as long as the process lives, which is the window it exists to close.

Verified end to end in the browser suite:

```
PASS  Acquisition is allowed while the line is operational — status 201
PASS  Degrading a production line in the vault blocks acquisition — status 409
PASS  Liquidation stays permitted while the breaker is armed — status 201
PASS  An unrelated asset class is unaffected — status 201
```

Liquidation staying open is the part that matters. A breaker that locked you into a position you cannot exit would be worse than no breaker.

### 3. The vault is validated like code

| Check | Severity | Why it earns its place |
| --- | --- | --- |
| `dangling_hub` / `dangling_factory` / `dangling_warehouse` | error | Someone renamed a node and something still points at the old name. |
| `asymmetric_link` | warning | Two files disagree about the physical world. |
| `unproducible_inventory` | warning | A warehouse holds something no upstream line can make — a data error, or genuinely stranded stock. |
| `capacity_exceeded` | error | Allocated storage exceeds declared capacity. |
| `frontmatter_invalid` | error | The file does not parse. |
| `block_size_missing` | warning | Utilisation cannot be computed for that holding. |
| `zero_cost_basis` | warning | Profit on the holding is undefined. |

`npm run preflight` now refuses a deployment whose twin has structural errors. The shipped vault reports **zero** issues, and a test asserts that — a fresh install that looks broken teaches people to ignore the warnings.

## The trap in the specification, made explicit

Specification §4 says to sell on any bid at or above 130% of acquisition. Its own pseudocode then contains `HOLD_REJECT_OFFER`: *"Gross offer meets target, but net transactional fees eliminate profit viability."*

Those two rules coexist uneasily, and a naive reading implements only the first. So `verdict` has four values, not three:

- `SELL_STRIKE` — bid clears the floor **and** nets positive
- `SELL_STOP_LOSS` — bid at or below the 15% floor; fires **even at a loss**, checked before net yield, because that is what a stop is
- `HOLD_UNECONOMIC` — clears the gross trigger, loses money after both fee legs, **refused**
- `HOLD` — between the floors

The UI shows `REFUSED — FEES` in amber for the third case. An operator watching a "target achieved" badge on a losing trade would rightly stop trusting the screen.

## Verification

| Suite | Result |
| --- | --- |
| `npm run lint` | clean |
| `npm test` | **134 / 134** (40 new) |
| `scripts/verify.mjs` | **76 / 76** (14 new) |
| `scripts/verify-tenancy.ts` | **15 / 15** |
| `scripts/preflight.ts` | 10 passed · 4 warnings · **0 blockers** |

Two existing store tests asserted `nodes.length === 3` and a literal list of connected nodes. Adding Warehouse Beta broke both. They now derive from the seed, so adding a vault node is no longer a test failure — only losing one on the round trip is.

## Still outstanding

- **The frontend platform decision.** Specification pp. 28–32 name Next.js 15 + Turborepo + pnpm; this is Vite + Express. Everything built after this point makes the migration more expensive.
- **`PRICING.md`** still reasons about a trading platform's liability profile.
- **Steps 4–5** of `RECONCILIATION.md`: the design system, then the enterprise modules, then pricing.
