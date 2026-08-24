# V12-CONST-001 — implementation report

The Constitution is loaded, anchored, and enforced by deterministic code at
boot and at every gated action. This document says exactly which Articles are
*enforced*, which are *declared but not enforceable from this repository*, and
which need a human or another signatory application before they mean anything.

That split is the whole point of the document. A constitution that is 40%
enforced and 100% described is more dangerous than no constitution at all,
because everyone downstream assumes the other 60%.

---

## The decision the rest of it rests on

§13.5 says an Inspector General is never an agent. §13.10 says nothing may
certify itself. Both are unenforceable if a Certificate of Release is a record
this process writes — **any code that can write a certificate can write itself
one**, and a field saying `kind: "human"` is a field an agent can also write.

So a certificate is not a record. It is a **collection of Ed25519 signatures
produced by keys this system does not hold.** Seats carry public keys only.
Determinations are signed out of band by the people holding the private halves.
At redemption the engine re-verifies every signature against the current seat
register.

There is no code path in this repository that can manufacture a concurrence,
because there is no private key here to manufacture it with. That is the same
property that made the Orion registry safe, and it is the difference between a
constitution that is enforced and one that is merely described.

The consequence, which is not a bug: **with nobody seated, this system releases
nothing.** `preflight` reports it as a blocker, because a production deployment
is itself a release under §13.3(7) and below quorum no certificate for it can
exist. Seating three Inspector Generals is a human act — `npm run
constitution:seat`.

---

## Enforced, with the failure proved

Every row was verified by breaking it deliberately and watching the system
refuse.

| Article | What runs | Proof |
| --- | --- | --- |
| **I §1.2 §1.3** | Digest recomputed at boot; absent, unparseable or mismatched refuses to start | Live: appending one comment to `constitution.yaml` stopped the boot |
| **I §1.3** | No bypass exists | A test asserts `anchor.ts` contains no `process.env` at all |
| **I §1.4** | Non-delegation | A test scans every enforcement module for model calls and fails on any |
| **I §1.5** | Unreachable dependency denies | No classifier configured → ingestion denied, never assumed clean |
| **II §2.1** | Production on a backend without RLS refuses to boot | Live: `NODE_ENV=production` on SQLite terminated with the citation |
| **III §3.1** | `Minor = bigint`; a `number` is refused, not converted | `0.1 + 0.2` cannot enter the ledger |
| **III §3.2** | Double entry checked before the database | An off-by-one-penny transaction is rejected with the difference named |
| **III §3.4** | Hash chain over tenant, run, amount, type, previous | Existing Apex audit chain, now cited |
| **III §3.5** | Margin floor absolute, returns the threshold it applied | 18.00% against a 25.00% floor → denied and named |
| **IV §4.3** | Exactly three verdicts, enforced by the return type | A fourth is not expressible |
| **IV §4.4** | Self-authorisation refused **before** the balance is consulted | Refused even with unlimited funds |
| **IV §4.5** | Receipts signed, single-use, bound to tenant + SKU + ceiling + expiry | Replay → critical; raising the ceiling after signing → forgery |
| **IV §4.6** | No launch against unverified stock | Denied at authorisation |
| **V §5.1–§5.3** | Rationale validated before the action clears | "The model decided" rejected; no inputs rejected; no threshold rejected |
| **VII §7.2** | Classifier absent = denial | Not a pass |
| **VII §7.6 / A10** | Instruction-smuggling detector | Seven attack shapes caught, benign business text not flagged |
| **X §10.2** | Halt denies the **next** action | Checked first, ahead of every other rule |
| **XI §11.1 §11.2** | Full ladder, automatic escalation 3-in-24h | Advisory ×3 → THROTTLE; escalation is per agent |
| **XI §11.3** | Self-service impossible | A suspension does not expire; lifting needs a named human and a justification |
| **XII §12.4** | Entrenchment | A **correctly anchored** amendment that weakens an entrenched Article is still refused |
| **XIII** | The entire gate | Below quorum, majority, unanimity, forged determination, self-review, vacuous reason, expired window, spent certificate, payload swap, unseating, per-destination clearance |
| **Sch. B** | The Oath is prepended to every model system instruction | Non-overridable, ahead of the product prompt |

**286 tests pass.** More usefully, I mutated four controls — always-quorum,
proposer-may-concur, margin-floor-off, entrenchment-check-removed — and each
mutation was caught. A green suite that survives having the code broken under it
is worth something; one that has never been tested that way is not.

---

## Not enforced. Read this part.

These are in the Constitution and are **not** enforced by this build. Some need
another signatory application, some need infrastructure, some need a person.
None of them should be assumed.

**Article II — the rest of tenant sovereignty.** §2.2 cross-tenant inference:
Apex has no vector store, so there is no embedding filter to enforce. §2.3
customer-managed keys: not built. §2.4 export and erasure propagation to every
signatory: Apex can export its own audit trail; propagation across the estate
requires the estate. The RLS **policies themselves** are not written — §2.1 is
enforced as a boot refusal, which prevents the unsafe deployment but does not by
itself create the row-level security. That is the next migration.

**Article VI — provenance and infrastructure.** TLS 1.3 with mutual
authentication, AES-256 envelope encryption under a managed KMS, ephemeral
single-batch containers in private subnets, least-privilege service accounts.
Every one of these is a deployment property, not application code. `render.yaml`
gives you TLS and a private database; it does not give you mTLS, KMS or
ephemeral ingestion.

**Article VII — the Sentinel classifier does not exist.** This is the largest
gap and the one most likely to be misread. The engine requires that a classifier
ruled and **denies when none has** — which is correct and fail-closed, but it
means Schedule A is currently enforced by refusal, not by detection. Nothing in
this repository can recognise CSAM, a breach corpus, or counterfeit media. The
injection detector in Article VII is a **heuristic pattern matcher**, useful
against the obvious shapes and not a substitute for classification.

**Article VIII — the perimeter.** No Sentinel agent, no weekly hardening cycle,
no ruleset propagation, no acknowledgement window, no anomaly scoring. The
ratchet clause (§8.3) has nothing to ratchet.

**Article IX — the decision journey.** Orion Prime → Nexion → V12 OS → ApexAtlas
→ Atlas Galaxy requires four services I cannot reach. Orion Prime is live but
its route list is still unknown (`ORION-PRIME.md`). Nothing enforces the
sequence today.

**Article XIII — City World.** §13.12 clearances are *recorded and required*;
they are not *obtained*. The engine refuses a feed share to any destination
without a recorded clearance, which is the right default — but the review itself
happens in Orion Prime's City World, which is not wired.

**Multi-instance state.** Sanction tallies, spent certificate serials and spent
receipt serials are per-process. Two instances would each count to three
separately and each accept the same certificate once. This moves to shared
storage before a second instance runs — the same constraint the rate limiter and
kill switch already carry, and `preflight` says so.

---

## Two places I read the Constitution against its author's likely intent

**The engine lives in TypeScript, not `app/constitution/engine.py`.** The
instrument names a Python path. Apex and Orion are TypeScript, and a Python
engine nothing consumes would enforce nothing while appearing to satisfy §1.4.
You chose TypeScript when I asked. The document should be amended under Article
XII to match, since right now the instrument names a file that does not exist.

**Development is not exempt, it is a different posture.** §13.13 says no
deployment posture disables Article XIII, so the gate runs in development too —
nothing releases without seats there either. What *does* differ is §2.1: SQLite
is permitted outside a production posture, because the alternative is that
nobody can run the app locally, and a control that makes local development
impossible gets deleted within a week. §1.3's "in a production posture" wording
is what carries this, and I want it on the record that I leaned on that clause.

---

## Running it

```bash
npm run constitution:anchor    # re-anchor after a deliberate amendment
npm run constitution:seat      # keygen / add / list Inspector Generals
npm run constitution:verify    # 66 conformance tests
npm run preflight -- <url>     # includes the constitutional blockers
```

`/api/health` reports the instrument, ratification, digest and whether the
Inspectorate holds quorum.

## What to do next, in order

1. **Seat three Inspector Generals.** Until then this system releases nothing,
   including its own deployment. Generate each keypair on that person's machine
   and register only the public half.
2. **Move to Postgres and write the RLS policies.** §2.1 is currently enforced
   as a refusal to boot, which is a guard rather than the isolation itself.
3. **Decide who builds Sentinel.** Article VII and the whole of Article VIII are
   waiting on it, and the honest current state is "denied for lack of a
   classifier".
