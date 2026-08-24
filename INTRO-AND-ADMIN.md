# Intro film, launch page, logo, and the invite API

Four things asked for, four things built. One of them is a security decision I want to be explicit about, and one is a typo in your artwork.

---

## 1. Arrival: film → launch page → workspace

A visitor now lands on the film. It dissolves into a launch page. From there they redeem an invite, sign in, or look around.

A splash screen is a tax on every visit, so this one is built around the ways that tax is usually levied unfairly:

- **Skippable from the first frame** — by click, by Escape, by Enter, by Space, and by a real focusable button. Not a 4px "skip" that appears after six seconds.
- **Plays once.** A returning visitor goes straight to the launch page. There is a "Play it again" control on the launch page for anyone who wants it.
- **Muted by default.** Every modern browser blocks autoplay with sound, so unmuted-by-default means *silently fails to start* on most machines. Sound is one labelled click away.
- **Respects `prefers-reduced-motion`.** Someone who has told their operating system that motion makes them ill gets the poster frame, not a ten-second tunnel flythrough.
- **Never traps anyone.** Failed load, failed decode, refused autoplay — all complete the sequence rather than leaving a black rectangle.

## 2. The film

`scripts/build-intro.sh` — reproducible, not a binary somebody hand-edited and dropped in. Re-run it after changing the source, the logo or the copy.

Added to your 8-second source:

| | |
| --- | --- |
| **Typography, three beats** | `URBAN VISIONS ENTERPRISES` → `MULTIMEDIA PRODUCT ARBITRAGE` → `ZERO-LOSS MANDATE`, with `d(pi) > 0.00 ENFORCED SERVER-SIDE` beneath the third. Every beat dissolves in and out — text that pops looks like a bug. |
| **Chromatic split** | Each line drawn twice, cyan offset two pixels under white. Reads as lens fringing on a HUD; costs nothing to render. |
| **Scanlines, vignette, grain** | The three cheapest cues that something is a screen. |
| **A running readout** | `SYS 006600`, counting. A HUD needs one thing that changes per frame. |
| **A logo card tail** | Your mark dissolving up on the app's own surface colour, signed `V12 APEX ATLAS / AGENTIC OPERATIONS WORKSPACE`, then dissolving out into the launch page. |

**10.7 seconds, 2.4 MB.** The first encode was 5.7 MB — film grain is close to incompressible, and 5.7 MB is a slow first paint on a phone for something nobody asked for. Grain came down, CRF went up, quality held.

### Two bugs worth recording

**The scanlines were four enormous bands.** I generated a 4×4 tile and scaled it to 1280×720 — a 320× magnification. Obvious in hindsight, invisible until you pull a frame and look at it. Now generated at output resolution.

**The film was being skipped on the browsers the fallback existed to serve.** H.264 is not universal: Chromium built without proprietary codecs — several Linux distributions, and the Chromium bundled with Playwright — cannot decode it. So I added a VP9/WebM second source. It still skipped, because React delivered the *first* source's error to `onError`, and my handler ended the sequence on it — while the WebM was loading perfectly well. The handler now asks the element whether it actually failed (`error` set **and** `readyState === 0`); anything else is a source being tried and discarded, which is the mechanism working. Caught by screenshotting the component and finding the launch page instead of the film.

## 3. The logo

`scripts/build-logo.py` derives everything from your one master: favicon, Apple touch icon, three web sizes of each variant, and a 1200×630 social card.

It is now in the header, the auth modal, the launch page, the film's closing card, the favicon, the no-JavaScript fallback and the social preview.

**One thing I changed, and why.** Your mark is chrome-on-white — a vertical gradient whose lower half is near-black. On this application's `#09090b` surface the bottom of the V, the "Multimedia" wordmark and most of the chrome simply disappear; you are left with a red outline floating in space. So there is a **reverse variant** that lifts the *neutral* pixels into the light half of the range and leaves the saturated ones alone. That distinction is the whole trick: lifting the red glow too turns crimson into pink, which is a different brand. Saturation is used as a mask and the glow passes through untouched. Shapes, proportions and colours-of-record are unaltered.

**One thing I did not change.** The mark reads **"Urban Visions Entertreprises"** — an extra *tre*. It is in the artwork, so it is now in the header, the favicon, the film and the social card. I have not touched it, because silently editing someone's logo is worse than flagging it. Say the word and I will regenerate every asset from a corrected master; it is a ten-minute job and much cheaper now than after a beta cohort has seen it.

## 4. The invite-minting API

You asked for it, and you quoted the reason it is dangerous back at me. Both things are true, so it exists and it is not a normal route.

```
POST   /api/admin/invites            mint
GET    /api/admin/invites            list — metadata only
POST   /api/admin/invites/:id/revoke
GET    /api/admin/usage              inference spend per tenant
```

Eight decisions, each defending against a specific failure:

1. **A dedicated secret, not a session role.** Roles belong to humans who get phished, share laptops and stay signed in. This token is not a login, is not in a cookie, cannot be replayed from a browser tab, and rotates by changing one environment variable.
2. **Absent by default.** With no `ADMIN_API_TOKEN` the routes are *not mounted*. A deployment that never configures one has no attack surface here — not a disabled one.
3. **404, never 401.** A wrong token gets the same response as a route that does not exist. There is nothing to probe for and nothing to confirm.
4. **A weak token refuses to boot.** Under 32 characters and the process exits. A short admin token is worse than none because it produces the confidence of having one.
5. **30 calls per hour**, keyed on the token rather than the IP, so rotating addresses does not buy a fresh budget.
6. **Everything audited** — including failures, with the caller's address, into the hash chain.
7. **Codes returned exactly once.** The list endpoint cannot return one; the store does not have it, only a SHA-256. The *audit entry* records ids and never codes, because an audit log containing working credentials is a credential store.
8. **Optional IP allowlist**, and query-string tokens are refused outright — they land in access logs, proxy logs, browser history and referrer headers.

`preflight` now **blocks** if that endpoint answers an unauthenticated request.

What none of this buys back: the token is a bearer credential and whoever holds it is an administrator. Keep it in a secret manager, not in a `.env` on a laptop, and rotate it when anyone with access leaves. `npm run invite` still works and remains the safer path.

---

## Verification

| Suite | Result |
| --- | --- |
| `npm run lint` | clean |
| `npm test` | **198 / 198** (21 new) |
| `scripts/verify.mjs` | **93 / 93** (7 new) |
| `scripts/verify-beta.ts` | **9 / 9** |
| `scripts/preflight.ts` | **14 passed · 3 warnings · 0 blockers** |

New browser checks:

```
PASS  Intro sequence is the first thing a visitor sees
PASS  The intro is skippable from the first frame
PASS  The intro offers both an H.264 and a royalty-free source — 2 sources
PASS  The intro dissolves into the launch page
PASS  The launch page states the beta is closed
PASS  The house mark is on the launch page
PASS  A returning visitor is not shown the intro again
```

---

## Two notes on the launch page

**It says the beta is closed, above the fold.** A landing page that hides the invite requirement until after someone has filled in a form turns interest into irritation, and the people arriving here already have a code in hand.

**The `noindex` policy is unchanged.** The app host still carries `noindex` and `robots.txt` still disallows everything — indexing an app host is how customer subdomains reach search results. This page is a front door for people with a link, not a page to rank. When there is public marketing to rank, it belongs on its own host.
