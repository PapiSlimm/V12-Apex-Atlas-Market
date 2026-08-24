# Design system

Step 4 of `RECONCILIATION.md`, and specification p. 30. Tokens, primitives, and the screens actually moved onto them.

---

## The platform decision, and why this went first

Specification pp. 28–32 name **Next.js 15 + Turborepo + pnpm**. This repository is Vite + Express. I have flagged that twice; here is the call.

**The design system is built first because its value does not depend on that decision.** Tokens are CSS custom properties and the primitives are React plus Tailwind — they port to Next.js unchanged. Building them now costs nothing under either branch, and it is the specification's own step 2.

What the Next.js migration would actually buy and cost, once, plainly:

| | |
| --- | --- |
| **Buys** | File-based routing and nested layouts — a real benefit at the specified 90+ pages and 14 modules. |
| **Costs** | The Express layer is where the CSP, the separately-headered sandbox route, helmet, CSRF, rate limiting, tenancy middleware and the graceful-shutdown path live. That is the most carefully built part of this codebase and a Next.js migration rewrites it. |
| **Also costs** | The desktop edition ships one `dist/server.cjs` as a Tauri sidecar. Next.js needs its own server runtime, which is a real regression against the specification's own "premium desktop application". |
| **Notably does not buy** | SSR and SEO. The app is behind a login and carries `noindex`; the marketing site is a separate host by design. |

My recommendation, for when you want to decide it: **take Turborepo + pnpm** — the specification asks for a shared UI package and Storybook, and a monorepo is the right shape for those regardless — **keep Vite + Express for the application**, and **put Next.js on the marketing site**, where SSR and SEO are the whole point. That is a documented deviation on one of three named technologies, not a rejection of the brief.

Nothing here forecloses the alternative. If you want the app itself on Next.js, this design system is exactly the layer that survives the move.

---

## Tokens

`src/design/tokens.css`. One place where a colour, radius or duration is decided. Components read roles (`--surface-2`, `--status-critical-ink`), never hexes.

The problem this solves is not aesthetic. Every panel in the app was `bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 shadow-xl`, hand-written in twenty places and subtly different in about six of them. That is why the **high-contrast theme did nothing** — it toggled a class no component read — and why three screens disagreed about what "warning amber" meant.

High contrast is now a token override: true-black surfaces, stepped-up lines and ink, and translucency removed. A glass panel over a busy background is exactly what a low-vision user does not need.

### Colour is computed, not chosen

The categorical series and status palette come from the data-visualisation guidance, **re-validated against this app's own surface** rather than the reference one:

```
node scripts/validate_palette.js "#3987e5,#d95926,#199e70,#c98500" \
  --mode dark --surface "#09090b"

[PASS] Lightness band      all 4 inside L 0.48–0.67
[PASS] Chroma floor        all 4 >= 0.1
[PASS] CVD separation      worst adjacent ΔE 8.4 (protan) · tritan 24.4
[PASS] Normal-vision floor worst adjacent ΔE 19.8
[PASS] Contrast vs surface all 4 >= 3:1
```

Status hues are fixed and never themed, so a status colour can never be mistaken for a data series — a test asserts that too.

Each status has a **mark** step and an **ink** step because a border and a paragraph have different jobs. `--status-critical` at `#d03b3b` measures **3.69:1** on the panel surface: correct for a 2px border or an icon, short of AA for body text. `--status-critical-ink` at `#ef6b6b` measures **5.89:1**. Contrast measured, not assumed.

---

## Primitives

| Component | The contract it enforces |
| --- | --- |
| `GlassPanel` | The static surface. Three tones, one elevation scale. |
| `QuantumCard` | The selectable surface. Keyboard-operable **by construction**. |
| `Button` | `type="button"` by default; a disabled button must supply `disabledReason`. |
| `StatTile` | Sentence-case label, no trailing colon; proportional figures. |
| `HeroFigure` | The one number a view leads with. Sans, ≥48px, one per screen. |
| `Meter` | Track is a lighter step of the fill's own hue — never grey. `null` ≠ zero. |
| `StatusChip` | Icon **and** word, always. The icon is chosen by role, so a caller cannot put a tick on a critical state. |
| `Alert` | Same, plus a deliberate choice between `role="alert"` and `role="status"`. |
| `DataTable` | A real `<table>` with `<caption>` and `<th scope>`. Numeric columns get `tabular-nums`. |

Three decisions worth defending:

**`type="button"` by default.** A `<button>` inside a `<form>` defaults to `submit`. Several buttons here sat inside forms and were one refactor away from submitting them.

**A disabled button explains itself.** `disabledReason` is surfaced as the tooltip *and* as visually-hidden text, because a tooltip is invisible to a keyboard-only user. Making it a named prop turns "why is this greyed out" into a required thought.

**Tabular figures only in columns.** `tabular-nums` gives every digit the width of a zero. That is correct in a table where figures must align, and makes a display number look loose. So `DataTable` sets it and `StatTile` deliberately does not.

---

## The accessibility defect this fixes

The asset rows and inventory holdings were `<div onClick>`: visible to a mouse, **unreachable by a keyboard**, and invisible to a screen reader as anything selectable. That is the most common defect in a hand-rolled card list and it existed in three places here.

`QuantumCard` bakes in what a native control does:

- `tabIndex=0` and `role="option"` inside a `role="listbox"`
- Enter **and** Space activate it, with Space's page-scroll prevented
- `aria-selected` carries the state — the emerald border is the echo, not the source
- An `aria-label` is part of the API, because a card named by its colour is not named

Focus rings are set once globally on `:focus-visible`, so a mouse click paints nothing and Tab always does. The single most common way a component library loses keyboard accessibility is each component reinventing that and one of them forgetting.

Six checks now guard this in the browser suite:

```
PASS  Inventory holdings are exposed as selectable options — 6 options
PASS  A selectable card is in the tab order
PASS  A selectable card carries an accessible name
PASS  Enter selects a card without a mouse — false -> true
PASS  Space activates the card rather than scrolling the page
PASS  Storage utilisation is exposed as a meter — 2 meters
```

`prefers-reduced-motion` is honoured globally rather than per-component, for the same reason.

---

## Adoption

A component library nobody imports is decoration. `SupplyNetwork` was rebuilt entirely on the system, and `AssetLedger` had its four hand-rolled panels, its two banners, its KPI grid, its status pills and its click-only rows moved across.

Two behaviour changes fell out of that:

- Order status pills previously had their own colour map, which disagreed with the twin's line-status colours about what amber meant. Both now go through `roleFor()`.
- The mandate verdicts read as words — `Auto-strike`, `Stop loss`, `Refused — fees`, `Hold` — instead of enum names shouted in caps.

---

## Verification

| Suite | Result |
| --- | --- |
| `npm run lint` | clean |
| `npm test` | **149 / 149** (15 new) |
| `scripts/verify.mjs` | **86 / 86** (10 new) |
| `scripts/verify-tenancy.ts` | **15 / 15** |
| `scripts/preflight.ts` | 10 passed · 4 warnings · **0 blockers** |

One test of my own was wrong and the suite caught it. I had written a rule that compaction drops the decimal on a two-digit mantissa — which would render `12.9K` as `13K`, contradicting the formatting contract's own example. The rule is now "one decimal, stripped when it is `.0`": `12.9K`, `9.9M`, and `12M` rather than `12.0M`.

The first version of the token checks also passed for the wrong reason — they read whatever theme an earlier check had left the toggle on. They now set the theme explicitly and compare both directions.

---

## Not built yet

Specification p. 30 lists fourteen component families. Nine are here. **Charts, Timelines, Drawers, Forms and Animated Backgrounds are not** — and I would rather ship nine that every screen uses than fourteen where five are shallow and unimported. Charts in particular should wait until there is a real time series to draw; the current data is a snapshot, and the correct form for a snapshot is the stat tile and meter already built.

Storybook is also not set up. It belongs with the monorepo, in the same piece of work as `packages/ui`.
