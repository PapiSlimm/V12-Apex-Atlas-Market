# Apex Atlas — sovereignty, the ecosystem, and outsiders

Three boundaries, three trust mechanisms, three blast radii. Getting these
confused is how an integration becomes an incident, so they are written down
before any more code depends on them.

---

## 1. Apex is sovereign, and I had this queued wrong

**Apex Atlas is part of V12 Multimedia. It is not part of the ecosystem.** It
seats its own Inspector Generals, and they are the only body that can certify an
Apex release.

I had queued the opposite. My reasoning was that two Inspectorates make Article
XIII §13.1's independence claim meaningless, so Apex should defer to Nexion's.
That was wrong, and it is worth saying exactly why because it is an easy mistake
to make twice.

§13.1 requires the Inspectorate to be independent of every application **in the
ecosystem**. Nexion's Inspectorate is independent *within* the ecosystem. Apex
sits outside it. Pointing Apex at Nexion would not have satisfied §13.1 — it
would have **inverted** it, making a body accountable to the ecosystem the gate
on an entity the ecosystem does not govern.

**One Inspectorate per sovereign, not one Inspectorate total.**

`server/constitution/sovereignty.ts` makes that structural rather than
aspirational:

- `CertificationSource` is a union with exactly **one** member,
  `'local-sovereign'`. Adding a remote source breaks every call site — which is
  the point. It should be impossible by accident and expensive on purpose.
- `certifySovereign` takes no URL, no peer, no fallback. A test asserts the file
  contains no `fetch(`, no `http://`, no `https://`. **It cannot reach the
  network.**
- Below quorum it refuses and stops. It does not go looking for someone else to
  ask.
- `refuseForeignCertificate` scans inbound payloads to six levels for
  `certificate`, `certificateOfRelease`, `releaseCertificate`, `inspectorate`.
  The ecosystem may send Apex **facts**; it may not send Apex **permission**.

That last guard exists because the attack is so cheap: a compromised — or merely
over-helpful — peer attaches a `certificate` field to a relay body, and an Apex
handler reads it because the shape matched.

---

## 2. Nexion has two roles, and that dissolves the contradiction

`NOT_IN_MESH = ['nexion']` and Article IX §9.2 both looked right and could not
both describe one interface. They describe two.

| | Reached through | In the mesh? |
| --- | --- | --- |
| **Adjudication** — "is this action permitted, given this evidence?" | the broker, signed and allow-listed like any peer call | **yes** |
| **Inspectorate** — the ecosystem's Superior Inspectorate General | directly, configured as `NEXION_API_BASE` | **no** |

§13.1 is why the second one is out. A body whose independence is guaranteed by a
registry that also lists the applications it reviews is not independent. So
`NOT_IN_MESH` is right *about the Inspectorate* and wrong as a statement about
Nexion the application. The fix isn't to add Nexion to the peer list — it's to
stop treating one hostname as one trust boundary.

Enforced, not just documented: `assertInspectorateNotRelayable` refuses to write
a registry containing any relay rule whose path starts with `/api/inspectorate`.

**Apex uses neither of these.** It adjudicates for itself and certifies for
itself.

---

## 3. The ecosystem can live inside Apex

Hosting is not membership. Apex can run the estate registry and the broker
surface within itself — the ecosystem placed *inside* Apex — without thereby
being governed by it. The relationship is a landlord's, not a member's:

- Apex's own Inspectorate still certifies Apex's releases.
- Apex's inbound policy still refuses any hosted member it chooses to.
- A hosted member's compromise reaches exactly the routes Apex's allow-list
  names, which by default is ping and capabilities.

`@v12/ecosystem-kit` is the mechanism: `ESTATE` and the broker are ordinary
modules, so mounting them inside Apex is a deployment choice rather than a
constitutional one.

---

## 4. Outsiders: the external integration API

Anyone who is not V12 gets `/api/v1/*` — versioned, documented, and deliberately
narrow.

```
GET /api/v1                → service metadata, unauthenticated
GET /api/v1/inventory      → inventory:read
GET /api/v1/twin           → twin:read
GET /api/v1/valuation      → valuation:read
GET /api/v1/audit?limit=n  → audit:read   (1..500, bounded server-side)

Authorization: Bearer apex_<keyId>_<secret>
```

**Why a key and not an ecosystem identity.** Members hold Ed25519 identities in a
registry Apex does not maintain. Requiring that of an outsider means either
issuing them a place in someone else's registry or inventing a second-class
membership. Both are worse than the boring answer.

**What makes it safe to hand to a stranger:**

- **Every route is read-only.** There is no external write path. Adding one is a
  per-route decision with the same question each time: what happens when this
  integrator is compromised?
- **The secret is stored only as a SHA-256 hash.** A leaked database yields no
  working key, and Apex genuinely cannot tell a customer their own key back —
  which is the correct answer to that request.
- **Scopes are deny-by-default and non-hierarchical.** `inventory:read` does not
  imply `inventory:write`. There is no `admin` and no `*`, because a wildcard is
  how a read-only integration quietly becomes a write one after a refactor
  nobody reviewed. A test asserts none exists.
- **Rate limits are per key**, not per tenant or per IP — one noisy integration
  must not starve another, and an IP is not an identity when everyone is behind
  a cloud NAT.
- **The Constitution applies to outsiders exactly as to internal agents.** Every
  request passes the engine before it is answered, and a refusal returns `451`.
  An external integration must not be a way around a halt, a tenant quarantine
  or a sanction.
- **Authentication failures are indistinguishable.** "Unknown key" and "wrong
  secret" both return one `401` with one message; distinguishing them is an
  oracle for enumerating issued keys. Insufficient scope *is* named, because the
  caller is already authenticated and `you need inventory:read` is the single
  most useful error an integrator can receive.

**Versioning is a promise.** `/api/v1` will not change shape. Fields may be
added; nothing is removed or retyped. A breaking change is `/api/v2` served
alongside. Cheap to promise now, impossible to retrofit after the first
integrator.

---

## Verification

| | |
| --- | --- |
| Apex `npm test` | **305 / 305** |
| Kit `npm test` | **38 / 38** |
| Lint, both | clean |

The checks that carry the argument:

```
PASS  below quorum Apex refuses and does NOT look for another Inspectorate
PASS  there is exactly one certification source
PASS  certifySovereign cannot reach the network
PASS  a certificate offered by an external party is refused, at any depth
PASS  a relay rule exposing the Inspectorate is refused
PASS  scopes do not imply one another
PASS  every external route is read-only
```

One test corrected itself along the way: I had listed `apex_only_two` as a
malformed key, but it is well-formed and *unknown* — a different answer that
must cost a database lookup. Conflating the two would mean either skipping
lookups for real keys or querying on every scrap of junk.

## Still open

- **The external router is not mounted yet.** It is built and tested; wiring it
  into `server.ts` needs a key store (a table) and is a change to a production
  posture — a release under §13.3(7).
- **Key storage is an interface, not a table.** `lookupKey` is injected;
  persistence lands with the mount.
- **Rate limits and key state are per-process**, like everything else here.
  Shared storage before a second instance runs.
