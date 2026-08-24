# Pricing & Partner Program — Firm Recommendations

You asked for my firmest recommendation optimised for profitability and cost safety. Here it is, with the reasoning, so you can overrule any piece you disagree with on grounds I've made visible.

**Two things I cannot determine for you**, and every number below is contingent on them:

1. **Your actual unit costs.** I don't know your inference spend per active user, your hosting bill, or your support load. The structure I recommend is robust to a wide range of those; the specific dollar amounts assume model inference is your dominant marginal cost, which is true for most agentic products.
2. **Your legal position.** I'm not a lawyer and this isn't legal advice. Where I flag regulatory exposure below, treat it as "get this checked," not "this is the law."

---

## The one principle everything else follows from

> **Never sell an uncapped variable cost at a fixed price.**

Your draft has "unlimited AI agents" at $99 and "unlimited users" at $299. In an agentic product, an AI agent *is* a cost centre that runs on its own. Unlimited agents at a flat price means your most engaged customer — the one getting the most value, the one you least want to lose — is also the one most likely to be unprofitable.

This is not hypothetical. An agentic workflow left running against a large document set can burn more inference in a weekend than a $99 subscription covers in a year. Every tier below has an **included allowance plus metered overage**. That single change does more for profitability than any price increase.

---

## Recommended tiers

Per-seat throughout. This is the biggest structural change from your draft, and the reason is in the next section.

| Tier | Price (monthly, per seat) | Annual (2 months free) | Seat range | Included model usage |
| --- | --- | --- | --- | --- |
| **Explorer** | Free | — | 1 | $2/mo, hard stop |
| **Professional** | $49 | $490/seat | 1–5 | $15/seat/mo |
| **Business** | $99 | $990/seat | 5–50 (5 min) | $30/seat/mo |
| **Enterprise** | $199 | $1,990/seat | 25 min | $50/seat/mo |
| **Enterprise+** | Custom | Custom | 50 min | Negotiated pool |

**Floors that matter:** Business starts at $495/mo. Enterprise starts at $4,975/mo (≈$60k ACV). Enterprise+ should not be quoted below **$100k ACV** — below that, the on-prem deployment, SLA and dedicated infrastructure you're promising cost more than the contract earns.

Overage: bill at **underlying cost × 1.4**, itemised on the invoice. Customers accept metered AI when they can see it; they revolt when it's opaque.

---

## Why per-seat, specifically

Your draft prices Business at $99 for 10 seats ($9.90/seat) and Enterprise at $299 for **unlimited** seats. Run that forward:

| Org size | Your draft | Per seat | Recommended | Per seat |
| --- | --- | --- | --- | --- |
| 10 people | $99 | $9.90 | $990 | $99 |
| 100 people | $299 | $2.99 | $19,900 | $199 |
| 1,000 people | $299 | $0.30 | $199,000+ | $199 |

The draft inverts the relationship between value delivered and revenue collected. Your largest customers — highest support load, most security review, most compliance work, most inference — pay the *least* in absolute terms.

**And the Enterprise tier as drafted is structurally unprofitable on its own promises.** It includes "24/7 support" and a "dedicated success manager." A fully-loaded CSM costs $80–150k/year. At $299/mo the tier earns $3,588/year. You would need 30–40 Enterprise accounts per CSM to break even on that one line item — before infrastructure, before support, before inference, before sales cost. The tier cannot fund what it sells.

If you want a headline number that reads like your draft, sell an **annual platform commitment** (e.g. "Enterprise from $59,700/yr") rather than a low monthly figure. Enterprise buyers don't compare monthly prices; they compare total contract value against budget.

---

## Correction: there is no trading module to split out

**An earlier version of this document was wrong, and the error had a runtime consequence, so it is corrected here rather than quietly deleted.**

It said Apex Atlas "executes financial transactions", recommended pricing that capability per organisation from $1,000/mo scaling with executed notional, and recommended gating it off Explorer and Professional entirely. That reasoning was built on my own misreading of the specification — the product settles a media business's *own* inventory against an internal marketplace and has never had an exchange, a broker or a venue. `RECONCILIATION.md` and `EXCISION.md` record the mistake and its removal.

The recommendation was not merely written down. It shipped: `PLAN_DEFAULTS` carried `tradingEnabled: false` for the free and $49 tiers, and a paying Professional customer placing an instruction received a `402` telling them their plan "does not include trade execution" — a capability the product does not have, blocking them from its central workflow. That is fixed; the entitlement is now `assetLedgerEnabled` and is on for every plan.

**What follows from the correction:**

- **The liability profile is ordinary B2B SaaS.** No customer can lose money through this software in the sense that reasoning assumed. No "no investment advice" clause, no venue-relationship terms, no incident-and-halt contract language is required.
- **There is no risk-based reason to gate the ledger by tier.** Gate scale instead — seats and inference credit — which is where the cost genuinely sits and which the entitlement model already enforces.
- **If a premium SKU is still wanted**, price it on twin size, audit retention or support, not on notional. Those correlate with your cost; notional does not.

---

## Affiliate program

Your draft: 20–35% recurring for 12 months, all tiers.

### The change that matters most

**Year-one commission, not lifetime.** That is the whole of it.

An earlier version of this section led with excluding "trading SKUs" from affiliate compensation on introducing-broker and financial-promotion grounds — FCA, MiFID II, FINRA. That analysis was answering a question this product does not raise: there is no trading SKU, and referring someone to an inventory workspace is ordinary software referral. The advice is withdrawn.

The real commercial constraint sits elsewhere and is flagged by `npm run preflight` on every run: **there is no usage metering.** Until inference spend per account is measured, any commission percentage is being paid against a margin nobody can calculate.

### Recommended rates

| Tier | Requirement | Commission | Notes |
| --- | --- | --- | --- |
| Community | Open | **20%** of year-one subscription | |
| Professional Partner | 10 active accounts | **25%** | |
| Certified Partner | 25 active + certification | **30%** | Capped at $5,000 per account |
| Strategic / Reseller | Contracted | **Margin-based**, not commission | Proper reseller agreement |

**Year-one only. Not lifetime, not "recurring."** A 30% lifetime commission means you permanently give away a third of the revenue on customers your own product retains. Year-one aligns the incentive where the affiliate actually adds value — acquisition — and lets your retention accrue to you.

### Three hard exclusions

1. **No commission on usage overage.** Overage is close to pass-through cost. Paying 30% of it can make an overage-heavy account *negatively* profitable. Commission on subscription revenue only.
2. **No percentage commission on Enterprise or Enterprise+.** Pay a **flat $2,500 referral fee on close**. Paying 30% of a $60k ACV deal to someone who wrote a blog post — when your sales team did the security review, the pilot and the procurement cycle — is a bad trade. Anyone who genuinely sources and closes enterprise deals should be on a reseller agreement, not an affiliate link.
3. **90-day clawback**, not 30. Full reversal on refund, chargeback, or cancellation inside 90 days. Self-referral and existing-pipeline attribution void the commission outright.

Cookie window: **60 days** across all tiers. Your draft's 30/60 split by tier adds administrative complexity for no acquisition benefit.

### Referral bonuses

Your draft gives the referrer a free month of Professional and the new customer 15% off three months. Keep the customer-side discount — it converts. Replace the referrer's free month with **account credit of equal value**, which is cheaper to administer, doesn't disturb your MRR reporting, and doesn't create a cohort of accounts that churn the moment the free month ends.

---

## Cost safeguards to build before you sell any of this

These are engineering, not policy, and none of them are large:

1. **Hard per-account inference ceiling, enforced server-side.** Not a dashboard warning — an actual refusal. Free tier must be incapable of exceeding its allowance.
2. **Usage metering per account, per model, per feature.** You cannot price what you cannot measure. Right now you have no idea what a Professional seat costs you, and every number in this document is a guess until you do.
3. **Overage billing wired to real cost**, so margin holds when model prices change.
4. **Kill switch on runaway agents.** An agent that loops is a bill that grows. Cap per-run token spend and wall-clock.
5. **Per-tier feature gating in the server**, not the UI. A gate that only exists in React is not a gate.

Item 2 is the prerequisite for everything else. **I'd build metering before you publish a price list** — a month of real usage data will tell you whether $15/seat of included inference is generous or suicidal, and I would not want you to find out from an invoice.

---

## Annual discount

Take **2 months free (16.7%)**, not 20%. It's the standard framing, it's easier to communicate ("two months on us"), and the 3.3% you keep is pure margin on your best-retained cohort. 20% is a lot to give for cash flow you may not need.

---

## What I'd change first, in order

1. **Add metering.** You are guessing at unit economics, including in this document.
2. **Do not gate the asset ledger by tier.** It is the product, and the risk rationale for gating it was wrong. Gate seats and inference credit instead.
3. **Move to per-seat**, and replace the Enterprise headline with an annual contract value.
4. **Cap the free tier hard**, server-side.
5. **Meter inference spend before paying any commission** — the margin is currently unknown — then get the program reviewed by counsel before launch.
