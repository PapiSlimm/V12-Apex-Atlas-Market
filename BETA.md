# Closed beta — operating manual

Free, invite-only, one instance, hard cap. Everything below is built, tested and verified.

---

## What was added

| Control | What it does |
| --- | --- |
| **Invite codes** | Registration requires a code. Codes are single-use by default, revocable, expirable, and hashed at rest. |
| **Population cap** | `BETA_MAX_TENANTS` is a hard ceiling on organisations, independent of how many codes you issued. |
| **Inference metering** | Every model call's tokens and estimated cost are recorded per tenant per month. |
| **Credit enforcement** | A tenant past its monthly credit is refused *before* the call, not after. |

That last pair closes the one caveat on the launch verdict: *"the free tier has no server-side inference cap — one enthusiastic user can spend your API budget."* It now can't.

---

## Running it

```bash
INVITE_ONLY=true
BETA_MAX_TENANTS=25            # or whatever you will actually support
MULTI_TENANT=true
AI_INPUT_CENTS_PER_MTOK=…      # from your provider's current price list
AI_OUTPUT_CENTS_PER_MTOK=…
```

Mint codes from inside the container:

```bash
npm run invite -- mint --label "alex@example.com"
npm run invite -- mint --count 10 --expires 30
npm run invite -- list
npm run invite -- revoke inv-…
npm run invite -- usage           # this month's spend per tenant
```

```
Minted 1 invite. Copy these now — they are not recoverable.

  EK8EA-T6ZUQ-GSUHB   (alex@example.com)

  uses: 1 each · expires: never
```

Then gate the release on:

```bash
npm run preflight https://your-deployment   # 0 blockers required
npm run verify:beta https://your-deployment # the gate, over HTTP
```

---

## Six decisions worth defending

**There is no API that mints invites.** An invite-printing endpoint is the highest-value target on a free beta — whoever reaches it prints themselves accounts against your API budget. Guarding it with a role means the guard is one middleware bug away from nothing. Not having it means there is no bug to find: minting requires shell access to the container, which is a capability you already control.

**Codes are hashed, never stored.** SHA-256 in, plaintext printed once and gone. A database dump, a backup, or an over-broad support query hands out working codes otherwise. Lose one and mint another — that is the correct trade.

**Redemption is a compare-and-swap.** Every precondition lives in the WHERE clause and the row count is the verdict. A read-then-write lets two people who paste the same code in the same instant both get in, and your cap becomes a suggestion. A test fires twelve concurrent redemptions at one code and asserts exactly one wins.

**The cap is independent of invites, and is checked first.** Two separate gates on purpose: minting thirty codes for a twenty-account beta must not commit you to thirty accounts. Order matters, and I got it wrong first — see below.

**The credit is checked before the call.** Checking after means the request that breaks the budget is the one you already paid for, and a long response can be most of the overage on its own.

**Unset token prices default HIGH.** They will be wrong; model prices change and I am not going to pretend to know today's. The placeholders over-state spend, so an operator who never configures them cuts users off early — annoying and recoverable. The cheap default under-counts and hands out an unbounded bill, which is not. `preflight` **blocks** if an API key is configured and the rates are not.

---

## Three bugs the tests found in my own work

**The cap burned invites it refused.** I originally redeemed the code and then checked the cap. A single-use code was consumed, the signup was refused for capacity, and the response told the person *"your invite is still valid."* It was not. The probe caught it — two valid codes went in, one account came out, two codes were spent. The cap is now checked first, and a probe asserts a refused signup leaves the code at `uses: 0`.

**Metering threw on the first call of every month.** `record` was UPDATE-then-INSERT-if-nothing-changed. Twenty simultaneous requests on a fresh period all see zero rows updated, all attempt the INSERT, and nineteen die on the primary key. The concurrency test found it immediately. It is now a single `ON CONFLICT ... DO UPDATE`, so the database resolves the race and no write is lost.

**The browser suite was flaky by construction.** It ran against the deliberately hostile marketplace model — 3% rejections, 2% simulated network failures — so several orders in, a red run meant nothing. A suite that is sometimes red for no reason teaches people to re-run it. It now warns when the target is not on `MARKET_BEHAVIOUR=calm`, and the header states plainly that the suite needs a **fresh** instance: it ends by degrading a production line to prove the breaker fires, so a second run against the same server is red for reasons that are not regressions.

---

## Verification

| Suite | Result |
| --- | --- |
| `npm run lint` | clean |
| `npm test` | **177 / 177** (28 new) |
| `scripts/verify-beta.ts` (fresh deployment) | **9 / 9** |
| `scripts/verify-beta.ts` (at capacity) | **6 / 6** |
| `scripts/verify.mjs` | **86 / 86** |
| `scripts/preflight.ts` | **13 passed · 3 warnings · 0 blockers** |

Proven end to end over HTTP:

```
PASS  A stranger with no invite code is refused — status 403 invite_required
PASS  An invented code is refused — status 403 invite_invalid
PASS  The refusal does not reveal whether the code ever existed
PASS  A valid invite is accepted — status 201
PASS  A single-use code cannot be shared — status 403
PASS  The redemption is traceable to the account it created
PASS  Headroom decreases as accounts are created — 2 -> 1
PASS  Registration is refused at the cap even with a valid code
PASS  A refused signup does not burn the invite — uses 0
```

Preflight now reports the beta posture rather than assuming it:

```
PASS  Registration is invite-only (3 code(s) redeemable)
PASS  Population capped at 25 tenant(s), 22 remaining
PASS  Inference metering is configured and enforced per tenant
```

and **warns** if `MULTI_TENANT=true` without `INVITE_ONLY=true` — an open free signup on a deployment holding a real API key is invisible from outside otherwise.

---

## Remaining warnings, and why they are fine here

- **SQLite** — correct for one instance. Move to Postgres when you want backups you have restored.
- **No billing** — you are not charging anyone.
- **Rate limits and kill switch are per-process** — correct on one instance, which is the shape you chose. Move both to Redis *before* you run a second one.

---

## What is not in this

**No invite emails.** Codes are printed to your terminal and you send them however you already talk to these people. A closed beta at this size does not need a transactional email integration, and adding one adds a provider, a domain reputation and a deliverability problem.

**No self-serve waitlist.** Same reasoning: you are choosing who gets in.

**No usage dashboard.** `npm run invite -- usage` prints the table. A screen for it belongs with Analytics, in the module work, not here.

---

Next: design and layout.
