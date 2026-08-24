# Orion Prime — what is actually running, and what it means

You gave me a URL: `https://orion-prime-wkvl.onrender.com`. I probed it. The
result changes the plan, so this document leads with the finding rather than
the work.

---

## The finding

**Orion Prime is not the broker I built. It is a different kind of thing.**

Here is the one response that is verified, quoted exactly:

```
GET /api/health

{"status":"online","system":"ORION PRIME MEGA (O.P.M.)",
 "version":"v12.4.0-MULTIMEDIA-ENTERPRISE",
 "timestamp":"2026-08-08T21:31:49.032Z","aiConnected":true}
```

And the page it serves describes itself as:

> ORION PRIME MEGA (O.P.M.) — V12 Multimedia AI multi-agent aggregator platform
> and operations console

So Orion Prime is a live, deployed **console and agent aggregator**. In the
hierarchy you described, that puts it alongside Nexion, V12 OS and CEOS — a
member of the ecosystem. What I built in `/root/orion` is a **broker**: the thing
that sits *between* members, verifies who is calling, and carries requests from
one to another.

Those are different layers, and the practical question is which one you
actually want:

| | |
| --- | --- |
| **Orion Prime already aggregates agents** | then `ask()` and `agent()` belong to it, my broker's router is redundant, and the only thing worth keeping from my build is the brokered member-to-member call |
| **Orion Prime is one member among several** | then the broker still has a job, and it should sit in front of Orion Prime rather than duplicate it |

I am not going to pick that for you. It is an architecture decision about your
estate, and both answers are defensible.

## What I could not establish, and why I stopped

Its API prefix is `/api/*`, not the `/v1/*` I specified. Beyond `/api/health`,
every path I tried came back as the console's own HTML — because the
single-page app answers a catch-all route.

**That result is ambiguous and I will not read it as an answer.** A `GET` to a
`POST`-only endpoint falls through to exactly the same catch-all as a route that
does not exist. From outside, "this endpoint isn't there" and "you used the
wrong verb" look identical. I only have GET available here.

So I stopped. Enumerating an API by guessing verbs and paths produces an
integration built on assumptions that hold right up until they don't, in
production, in front of a user.

**What would settle it in about a minute:** the Orion Prime repository, or its
route file, or whatever `/api/*` handlers it registers. Point me at the repo and
this stops being guesswork.

## Where the wire contract now stands

The `orion-v2` contract in `orion/README.md` and Orion Prime **disagree already**
on the one thing I can see — `/v1/*` versus `/api/*`. I said when I wrote it that
where the two disagree, the document is what changes. That still holds. But it
should change to match Orion Prime's *real* surface, not my inference of it.

The Ed25519 identity model is a separate question from the URL shape, and worth
keeping regardless of which layering you choose. Nothing I saw suggests Orion
Prime has a credential model for member-to-member calls at all — its health
endpoint is unauthenticated, which is correct for a health endpoint and tells me
nothing about the rest.

---

## What I built anyway, because it does not depend on the answer

**`server/orion-prime.ts`** — a deliberately tiny outbound module. It implements
the one call that is verified and refuses to guess at the others. The seam is
there; when the route list is known, an adapter goes in beside `health()` and
nothing else in Apex moves.

It is defensive in ways that matter for this specific service:

- **A 200 of HTML is not health.** The catch-all means a 200 proves only that
  something served a web page. The module parses and shape-checks before
  believing anything, and there is a test for exactly this.
- **`redirect: 'manual'`.** A redirect could carry the request to a host nobody
  authorised.
- **Plaintext `http://` to a public peer is refused** at configuration time.
- **It sends nothing.** No tenant data, no credentials, no identity. Apex and
  Orion Prime are independently governed; an outbound call carrying Apex's
  identity would couple them quietly.
- **It never throws.** Orion Prime being asleep is a fact to display, not an
  exception for Apex to propagate. A page that 500s because a sibling service is
  idle has made an optional dependency mandatory by accident.

Run it yourself:

```bash
ORION_PRIME_URL=https://orion-prime-wkvl.onrender.com npm run orion:check
```

I have not run that from inside this session — my sandbox's outbound HTTP goes
through a restricted fetch path, so the live response above came from that path
and is recorded in the tests verbatim. The module is verified against that exact
body; the round trip from Apex's own code is yours to confirm, and the command
above is the whole confirmation.

## What is deliberately still off

`ORION_PUBLIC_KEY` is unset in the deployment, which disables Apex's entire
inbound ecosystem surface. That is the correct state until the contract question
above is settled. Apex governs its own inbound policy — deny-by-default callers,
deny-by-default routes — and "no policy decided yet" resolves to "nothing gets
in", not to "let the broker decide".

---

## Next, in order

1. **Send me the Orion Prime repo or its route list.** Everything else about the
   integration is blocked on this and nothing else.
2. **Decide the layering** — does Orion Prime *become* the broker, or sit behind
   one?
3. Deploy Apex to Render, which is not blocked on either of the above. See
   `render.yaml` and `DEPLOYMENT.md`.
