/**
 * AETHER SUITE — application for admission to the Atlas Galaxy under Apex.
 *
 * Every finding below was read out of the source at
 * `C:\Users\Ron Dixon\Desktop\AETHER`, not inferred from the manual. Where the
 * manual and the code disagree, the code is what is recorded — the manual
 * describes "Strict Zero-Trust Network Access", "dynamic tenant namespace
 * separation" and "SOC2 continuous compliance verification", and the schema
 * describes something else. That gap is the reason admission is assessed from
 * source.
 *
 * WHAT AETHER IS
 * --------------
 * A multi-tenant B2B intelligence platform: bookkeeping and a transaction
 * ledger, invoices, vendors, contract lifecycle with AI drafting and valuation,
 * predictive inventory, workforce burnout analytics, ZTNA device posture, and
 * media clips/webinars. React + Vite front end, Express + Drizzle + Postgres
 * back end, Firebase ID-token authentication, Gemini through a server-side
 * gateway.
 *
 * It is a serious piece of work. It is also, today, refused — and the two facts
 * are unrelated. The bar is not quality; it is four entrenched Articles.
 */

import type { AdmissionCandidate } from './admission';

export const AETHER: AdmissionCandidate = {
  appId: 'aether-suite',
  name: 'Aether Suite',
  services: [
    'bookkeeping-ledger',
    'invoicing',
    'vendor-management',
    'contract-lifecycle',
    'predictive-inventory',
    'workforce-burnout-analytics',
    'ztna-device-posture',
    'media-clips-webinars',
    'ai-copilot',
  ],
  resources: [
    'transactions',
    'invoices',
    'vendors',
    'contracts',
    'inventory',
    'burnout_metrics (employee wellbeing — sensitive)',
    'ztna_devices',
    'webinars',
    'clips',
    'audit_logs',
    'users (Firebase-linked)',
  ],
  findings: [
    // ---------------------------------------------------------------- Article III
    {
      article: 'III',
      section: '§3.1',
      observed:
        'Monetary quantities are stored as IEEE 754 double precision. §3.1: "Floating-point representation of ' +
        'monetary quantities is forbidden."',
      evidence:
        'src/db/schema.ts — transactions.amount, contracts.value, invoices.amount and vendors.totalPaidThisYear ' +
        'are all doublePrecision().',
      remedy:
        'Store minor units as bigint/numeric. A migration, plus a boundary guard that refuses a JavaScript number ' +
        'rather than converting one — by the time a value is a float the precision is already gone.',
    },
    {
      article: 'III',
      section: '§3.1',
      observed:
        'A language model is asked to produce a monetary figure. §3.1: "No language model output is ever treated ' +
        'as an arithmetic result."',
      evidence:
        'server.ts POST /api/ai/suggest-contract-value — the prompt asks Gemini for "a realistic, market-accurate ' +
        'B2B SaaS annualized evaluation (e.g. between $10,000 and $1,000,000)".',
      remedy:
        'A model may propose a band and a rationale; the figure that reaches a contract must be computed by ' +
        'deterministic code from named inputs, or entered by a person. Keep the suggestion, label it a suggestion, ' +
        'and never let it be the value.',
    },
    {
      article: 'III',
      section: '§3.2',
      observed:
        'Transactions are single-amount rows. There is no balanced double-entry structure, so no transaction can ' +
        'be shown to balance.',
      evidence: 'src/db/schema.ts — transactions has one amount column and no leg/account structure.',
      remedy:
        'Model each monetary event as balanced legs summing to zero, rejected before the database sees it and ' +
        'again by constraint.',
    },
    {
      article: 'III',
      section: '§3.3',
      observed:
        'The ledger is deletable. §3.3: "Ledger entries are append-only. There is no UPDATE and no DELETE on the ' +
        'ledger." This is the most serious finding in the application.',
      evidence:
        'server.ts POST /api/ledger/wipe issues db.delete(transactions) plus eight further tables for the calling ' +
        'user; DELETE /api/transactions/:id removes individual entries.',
      remedy:
        'Remove both paths. A correction is a new linked reversing entry that states its cause. If a demo needs a ' +
        'clean slate, give the demo its own tenant and destroy the tenant, never the ledger.',
    },
    {
      article: 'III',
      section: '§3.4',
      observed:
        'The audit log is not hash-chained, so tampering is undetectable and §3.4\'s "break in the chain" can never ' +
        'be observed.',
      evidence:
        'src/lib/audit-logger.ts inserts rows with no prevHash/hash; src/db/schema.ts auditLogs carries no digest ' +
        'column. The write is also wrapped in try/catch that logs and continues, so a failed audit write does not ' +
        'stop the action it was meant to record.',
      remedy:
        'SHA-256 over the entry and its predecessor, per tenant, with a verification sweep. And a failed audit ' +
        'write must deny the action (Article I §1.5), not be swallowed.',
    },
    // ----------------------------------------------------------------- Article II
    {
      article: 'II',
      section: '§2.1',
      observed:
        'Tenant isolation is a userId foreign key plus WHERE clauses in application code. §2.1: "Application-layer ' +
        'filtering alone is insufficient and is expressly forbidden as a sole control."',
      evidence:
        'src/db/schema.ts — every table carries userId with onDelete cascade; no row-level security policy exists ' +
        'anywhere in the repository. The manual\'s "dynamic tenant namespace separation" is not present in the schema.',
      remedy:
        'PostgreSQL row-level security bound to a session organisation claim, so a missing WHERE clause returns ' +
        'nothing instead of returning everything.',
    },
    // ---------------------------------------------------------------- Article VII
    {
      article: 'VII',
      section: '§7.2',
      observed:
        'No classifier stands at any ingress point. §7.2 requires every ingress — API, upload, model output — to ' +
        'pass the Sentinel classifier before the payload reaches storage.',
      evidence:
        'server.ts — no classification call on any POST route, and none on model output before it is persisted or ' +
        'returned.',
      remedy:
        'A classifier at the boundary, and a deny when it is unreachable. An absent classifier must be a refusal, ' +
        'never an assumed pass.',
    },
    // ---------------------------------------------------------------------
    // Below: Articles IV, V, VI and XI are NOT entrenched, so they record as
    // conditions. Article XIII IS entrenched and therefore blocks — the engine
    // sorts by the entrenched list, not by where a finding sits in this file,
    // which is why the §13.2 finding below appears under BLOCKING in the
    // dossier. Its remedy is unusual: admission itself supplies the missing
    // gate, because a dependant of Apex is certified by Apex's Inspectorate.
    // ---------------------------------------------------------------------
    {
      article: 'V',
      section: '§5.1',
      observed:
        'Consequential AI actions carry no rationale recorded before the action clears — categorisation, contract ' +
        'drafting, burnout analysis, inventory recalculation.',
      evidence: 'server.ts /api/ai/categorize, /api/ai/draft-contract, /api/ai/analyze-burnout.',
      remedy: 'Record a rationale naming the inputs and threshold before the write, and refuse the action without one.',
    },
    {
      article: 'IV',
      section: '§4.1',
      observed: 'Contract approval commits value with no comptroller authorisation receipt.',
      evidence: 'server.ts POST /api/contracts/approve.',
      remedy: 'A signed, single-use receipt bound to tenant, counterparty and ceiling, issued by a party that is not the proposer.',
    },
    {
      article: 'XI',
      section: '§11.1',
      observed: 'No sanctions ladder. A violation has no automatic consequence.',
      evidence:
        'Searched server.ts and src/ for constitution/sanction/violation/severity handling — no match. ' +
        'Compare Orion Prime, which carries constitution-engine.ts and constitution/constitution.lock.',
      remedy: 'Adopt the ladder, or defer to Apex\'s engine once admitted.',
    },
    {
      article: 'XIII',
      section: '§13.2',
      observed: 'No release gate. Contract generation and publication proceed without a Certificate of Release.',
      evidence:
        'Searched server.ts and src/ for inspectorate/certificate/release-gate handling — no match. ' +
        'src/lib/ai-gateway.ts returns model output straight to the caller with no gate.',
      remedy: 'Under Apex, releases would be certified by APEX\'S OWN Inspectorate — Aether would not seat its own.',
    },
    {
      article: 'VI',
      section: '§6.5',
      observed:
        'Any Firebase UID listed in SUPER_ADMIN_UIDS is auto-provisioned as super_admin on first sight of a token; ' +
        'everyone else is auto-created as viewer.',
      evidence: 'src/middleware/auth.ts — user row inserted on first authenticated request, role read from env.',
      remedy:
        'Least privilege wants provisioning to be an explicit grant. Auto-creation on first token means the ' +
        'environment variable is the whole access-control system.',
    },
  ],
};

/**
 * What Aether would be appointed as, once the blocking findings are cleared.
 *
 * Recorded now rather than after, because the appointment shapes the
 * remediation: knowing it would hold financial primitives is why the Article III
 * findings are the ones that matter most.
 */
export const AETHER_APPOINTMENT = {
  appId: 'aether-suite',
  /**
   * Under APEX, not in the v12-ecosystem. Apex is outside that ecosystem and
   * governs its own dependents; placing Aether in the ecosystem registry would
   * put it under a governance Apex does not control.
   */
  governedBy: 'V12 Apex Atlas',
  realm: 'apex-galaxy',
  role: 'financial-and-operations-primitives',
  capabilities: [
    'bookkeeping-ledger',
    'invoicing',
    'vendor-management',
    'contract-lifecycle',
    'predictive-inventory',
    'workforce-analytics',
    'device-posture',
  ],
  /**
   * Scopes on Apex's external API. Read-only, because Aether is an applicant
   * rather than a member and write access is a decision made per route.
   */
  externalScopes: ['inventory:read', 'valuation:read'] as const,
  /**
   * Deliberately NOT granted, and worth stating explicitly:
   *  - twin:read — the production graph is not Aether's concern
   *  - audit:read — one applicant reading Apex's decision record is a
   *    surveillance surface nobody has asked for
   */
  withheldScopes: ['twin:read', 'audit:read', 'webhook:receive'] as const,
} as const;
