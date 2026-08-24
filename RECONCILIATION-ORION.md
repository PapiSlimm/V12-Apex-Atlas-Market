# Reconciliation against the real Orion Prime

I read the source. Three things are true that change the plan, and the first one
is the reason nothing has been connecting.

---

## 1. The broker exists, is well written, and is not running

`ecosystem.ts` is 40 KB of careful work: `requireEcosystemAuth`, a peer registry
with per-peer allow-lists, `/ask`, `/agent/:name`, `/relay`, City World research
jobs. It fails closed when no secret is configured. Somebody thought about
confused-deputy attacks while writing it.

**`server.ts` never imports it.**

```
$ grep -n "from './ecosystem'" server.ts
$                                    # nothing
```

The only thing mounted under that prefix is the feed intake:

```ts
app.use('/api/ecosystem/feed', createFeedIntake({ serviceId: 'orion-prime' }));
```

So `createEcosystemRouter` is dead code. Not one line of it executes in
production. `ORION PRIME AIOS` does not contain `ecosystem.ts` at all.

This is the answer to the question I could not resolve by probing. When I
GET-probed `/api/ecosystem/ping` and got the console's HTML, I wrote that a GET
against a POST-only route is indistinguishable from a route that does not exist
and refused to guess. It was the second one. **There is no broker surface live in
the estate**, which is why nothing is connected to anything.

**The fix is roughly one line**, plus mounting it before `express.json()` so the
raw body survives for HMAC verification:

```ts
import { createEcosystemRouter } from './ecosystem';
app.use('/api/ecosystem', createEcosystemRouter({ /* deps */ }));
```

I have not made that change. It is a change to a security control and to a
production deployment — §13.3(5) and §13.3(7) — so it is a release, and it needs
a Certificate.

---

## 2. There were two constitutions. Apex now uses yours.

```
Orion Prime + Nexion   62f0bf8a5f165425…   deployed
Apex (mine)            93fff9a020402072…   written from the instrument text
```

Your `constitution-engine.ts` says Orion Prime and Nexion enforce "the
byte-for-byte identical constitution.yaml (same SHA-256 anchor)". Apex was
shipping a third file under the same instrument name — which means Apex was
enforcing a *different constitution* while claiming to enforce yours. That is
worse than not enforcing one, because everyone downstream assumes the anchor
means agreement.

**Corrected.** Apex now anchors your bytes, unchanged, and
`server/constitution/canonical.ts` translates your schema into the shape Apex's
engine already enforces. The digest must be over the estate's canonical bytes;
how one process represents them in memory is nobody else's business, and making
the estate adopt my field names would have been the tail wagging the dog.

Apex's `constitution.lock` is now byte-identical to yours too. It nearly was
not: I had written it in `sha256sum` format (`<digest>  constitution.yaml\n`)
while yours is a bare digest, so re-anchoring in Apex would have silently forked
the lock file away from the other two services. A round-trip test caught it.

### Two things your canonical file does not carry

Apex enforces them, and they are **not protected by the anchor** — someone can
change them without breaking the digest. Both belong in the file, which is an
Article XII amendment:

- **Schedule B, the Agent Oath.** Not in `constitution.yaml`. Supplied from the
  instrument text and marked `derived`.
- **The Article V §5.3 rationale standard.** Also absent. This one is a live
  divergence rather than a gap: your Gate 1 accepts any rationale of **12
  characters** that does not say "the model decided". §5.3 requires the
  rationale to "name the specific inputs relied upon and the specific threshold
  applied", and twelve characters cannot do that. Apex enforces 40 characters
  plus named inputs plus a named threshold. **One of the two implementations is
  not enforcing the Article** — I think it is Gate 1, but it is your call, and
  whichever way it goes both should match.

---

## 3. Transit is shared secrets, and I built Ed25519

Your scheme, from `v12-webhook.ts`:

```
V12-Signature: t=<unix_seconds>,v1=<hex_hmac_sha256>
HMAC-SHA256 over `${t}.${rawBody}`, 300s tolerance, constant-time compare
```

That construction is fine — it is Stripe's, it is easy to implement in any
language, and the file is properly vendored with a test asserting the copies
match. I have vendored it into the kit **byte-identically** (`sha256
da2ed743…`), so the kit can speak your scheme without forking it.

The problem is not the MAC, it is the key distribution. `ORION_PEERS` puts every
peer's secret in Orion Prime's environment. Compromise Orion Prime and you can
*be* Sociofy, CEOS, V12 OS and V12 Multimedia — and `relay()` turns that from an
exploit into a documented feature. It is the same finding you made me act on
earlier in this project, and it is still true here.

I am not proposing you rip it out. Your own code already has the migration
mechanism: `legacyToV12Header` and `V12_SIGNATURE_STRICT=1` show you know how to
run two schemes and retire one. The same staged path works for HMAC → Ed25519,
and the kit is built to carry both.

---

## Also worth knowing

**`NOT_IN_MESH = ['nexion', …]` is correct and I want to say so**, because it
looks like a mistake. §13.1 requires the Inspectorate to be independent of every
application; keeping its host out of the peer mesh is exactly right. But it does
collide with Article IX §9.2, which puts Nexion at step 2 of the decision
journey as the adjudicator. Nexion cannot be both outside the mesh and a
required hop inside it. One of those needs to give — most likely Nexion exposes
adjudication on a separate, narrower interface from the Inspectorate.

**Gate 2 is unconfigured.** `NEXION_API_BASE` is empty in `.env.example`, so
every syndication release currently fails closed. That is the correct behaviour
and it means nothing is publishing today.

**Apex's Inspectorate should not be local.** I built Apex with a local seat
register. The estate's Inspectorate lives in Nexion at
`/api/inspectorate/review`. Apex should defer to it the way Orion Prime does,
rather than seat its own — otherwise there are two Inspectorates and §13.1's
independence claim is meaningless. That change is queued, not made.

---

## What I changed

| | |
| --- | --- |
| `constitution/constitution.yaml` | replaced with yours, byte-identical |
| `constitution/constitution.lock` | replaced with yours, byte-identical, and `anchor()` now writes your format |
| `server/constitution/canonical.ts` | new — adapts your schema to Apex's engine |
| `server/constitution/anchor.ts` | detects and adapts the canonical schema |
| `v12-kit/src/v12-webhook.ts` | your signing contract, vendored verbatim |

Apex: **286/286 tests, lint clean.** Kit: **36/36**. Orion: **75/75**.

## What I did not change, and why

Everything that is a release under Article XIII: mounting the broker, wiring
Gate 2, altering a security control. There are still zero Inspector Generals
seated anywhere I can see, so no Certificate can be issued for any of it. That
is the gate working, not the gate being in the way.

## The order I would do this in

1. **Mount `createEcosystemRouter`.** Nothing else in the estate can connect
   until the broker surface is actually served. One line, before `express.json`.
2. **Set `NEXION_API_BASE`** and confirm Nexion's Inspectorate answers, so Gate 2
   stops refusing everything.
3. **Settle the Article V divergence** — 12 characters or 40 with named inputs.
4. **Amend the canonical file** to carry Schedule B and the Article V standard,
   so they are inside the anchor rather than beside it.
5. Then the shared-secret question, on your own timetable.
