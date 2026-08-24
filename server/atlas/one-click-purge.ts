/**
 * ONE-CLICK DATA PURGE — application for admission to the Atlas Galaxy.
 *
 * A GDPR/CCPA compliance engine and digital footprint monitor: exposure
 * scanning against data brokers and breach corpora, one-click erasure requests,
 * OAuth permission management and token revocation, cookie clearing, weekly
 * exposure audits.
 *
 * The premise is squarely aligned with the Constitution — Article II §2.4 gives
 * a subject the right to demand erasure, and a tool that exercises that right on
 * their behalf is a good idea. I want to be clear about that before the rest,
 * because the rest is severe.
 *
 * WHAT THE CODE ACTUALLY DOES
 * ---------------------------
 * Nothing it reports. The exposure findings are invented by a language model.
 * The erasure requests are in-memory objects with random tracking numbers. The
 * OAuth revocations flip a boolean in an array. No request leaves the process,
 * no token is revoked at any provider, and no data broker is ever contacted.
 *
 * A person using this believes their data was purged and their Google and Meta
 * tokens were revoked. They will stop taking the real action, because they
 * think it is handled. That is worse than doing nothing at all, and it is the
 * reason this assessment leads with harm to the person rather than with the
 * Article list.
 */

import type { AdmissionCandidate } from './admission';

export const ONE_CLICK_PURGE: AdmissionCandidate = {
  appId: 'one-click-purge',
  name: 'One-Click Data Purge',
  services: [
    'digital-footprint-scanning',
    'gdpr-ccpa-erasure-requests',
    'oauth-permission-management',
    'token-revocation',
    'cookie-clearing',
    'weekly-exposure-audit',
  ],
  resources: [
    'subject PII: full name, email, phone, country, region — of a NAMED LIVING PERSON',
    'claimed data-broker exposure records',
    'claimed breach-leak associations',
    'social OAuth permission inventory (Google, Meta, Twitter, LinkedIn, Slack)',
    'compliance_logs (in memory)',
    'cookie manifests',
  ],
  findings: [
    // -------------------------------------------------------------------------
    // The two that hurt a person. Everything else is bookkeeping next to these.
    // -------------------------------------------------------------------------
    {
      article: 'VII',
      section: '§7.1 / Schedule A8',
      observed:
        'Token revocation is simulated. POST /api/social/revoke/:id flips an in-memory status field and writes a ' +
        'compliance log saying "Scope Access Revocation". No OAuth provider is contacted and no token is revoked.',
      evidence:
        'server.ts:428 — the handler mutates socialPermissions[targetIndex].status and returns. There is no HTTP ' +
        'call to Google, Meta, Twitter, LinkedIn or Slack anywhere in the file.',
      remedy:
        'Either call the providers\' real revocation endpoints, or label the control "simulated" in the UI and the ' +
        'log with the same prominence as the success state. A compliance log asserting a revocation that did not ' +
        'occur is a false record, not an optimistic one.',
      subjectHarm:
        'A user clicks Revoke on a Google or Meta token, sees "Revoked", and the token remains fully live. They ' +
        'now believe a live credential is dead and will not revoke it for real. This is worse than the app not ' +
        'existing.',
    },
    {
      article: 'VII',
      section: '§7.1 / Schedule A8',
      observed:
        'Erasure requests are simulated. POST /api/purge fabricates tracking numbers of the form ' +
        '`TRK-CCPA-<random 7 digits>` and creates in-memory request records. No erasure demand is transmitted to ' +
        'any data broker.',
      evidence: 'server.ts:325 — the handler maps the requested databases to objects with Math.random() tracking ids.',
      remedy:
        'Send real requests, or present the feature as a request GENERATOR that produces templates the user sends ' +
        'themselves. The app already generates a legal template, which is genuinely useful and honest.',
      subjectHarm:
        'A user believes a statutory erasure demand is in flight under GDPR or CCPA, with a tracking number they ' +
        'could quote. Nothing was sent. Statutory response clocks they think are running are not running.',
    },
    // -------------------------------------------------------------------------
    {
      article: 'VII',
      section: '§7.1 / Schedule A8',
      observed:
        'The exposure findings are model output presented as observation. Gemini is asked which brokers "likely ' +
        'hold their records" and to supply an exposure score, a record count and a breach-leak count. No dataset ' +
        'is queried.',
      evidence:
        'server.ts:228 POST /api/scan — the prompt asks the model to "Identify high-risk data-brokers … or ' +
        'historic breach leak targets that likely hold their records" and return counts. Named brokers appear in ' +
        'the prompt as examples, so the model returns plausible names rather than found ones.',
      remedy:
        'Query real sources, or state on the result screen that findings are estimated by a model and not ' +
        'observed. The simulation-mode disclaimer already does this well — live mode should be at least as honest.',
      subjectHarm:
        'A named real person is told specific companies hold their data and that they appear in a number of ' +
        'breaches. Both may be false, and both are actionable-feeling.',
    },
    {
      article: 'X',
      section: '§10.4',
      observed:
        'The live-mode disclaimer misdescribes the data source. With no API key the app says it is simulating, ' +
        'which is candid. With a key it claims "live digital footprint analytics from global threat datasets" — ' +
        'the source is a language model, not a threat dataset.',
      evidence: 'server.ts:242 — the simulation disclaimer text names the capability that live mode is said to activate.',
      remedy:
        'Say what the source is. §10.4 forbids misreporting a limitation of one\'s own competence, and the ' +
        'fallback path is currently more honest than the paid one.',
      subjectHarm:
        'The disclaimer teaches the user that the non-simulated mode is real. It is the sentence that converts a ' +
        'demo into a belief.',
    },
    {
      article: 'II',
      section: '§2.1',
      observed:
        'There is no tenancy and no authentication. Every route is open, and state is module-level arrays shared ' +
        'by every caller of the process.',
      evidence:
        'server.ts:33 — "In-memory simulator states"; currentPurgeRequests, socialPermissions and complianceLogs ' +
        'are module scope. No auth middleware appears on any route.',
      remedy:
        'Authentication, then tenant isolation at the database layer. Until then one user\'s purge list and ' +
        'compliance log are visible to the next.',
      subjectHarm:
        'Two people using the same deployment see each other\'s exposure findings and compliance history — which ' +
        'is precisely the harm this product exists to prevent.',
    },
    {
      article: 'VII',
      section: '§7.2',
      observed:
        'POST /api/scan accepts a named individual\'s full name, email and phone from an unauthenticated caller and ' +
        'sends them to a third-party model. No classifier stands at the boundary.',
      evidence: 'server.ts:228 — input is read from req.body and interpolated directly into the prompt.',
      remedy:
        'Classification at ingress, a lawful-basis check before processing a third party\'s PII, and a refusal when ' +
        'the classifier is unreachable. Schedule A3 covers unlawfully obtained personal data, and an open endpoint ' +
        'that profiles anyone whose details you can type is the mechanism for producing it.',
      subjectHarm:
        'Anyone can profile anyone. The subject of a scan need not be the person running it, and never consents.',
    },
    // ------------------------------- conditions --------------------------------
    {
      article: 'V',
      section: '§5.1',
      observed: 'No rationale is recorded before a purge request or revocation is created.',
      evidence: 'server.ts:325 and :428 — both write records with no reasoning field.',
      remedy: 'Record what was relied upon and which threshold applied, before the record is written.',
    },
    {
      article: 'VI',
      section: '§6.1',
      observed: 'Compliance logs are unanchored and in memory; they do not survive a restart and cannot be verified.',
      evidence: 'server.ts:33 — complianceLogs is a module-level array.',
      remedy: 'Durable storage and a hash chain, so a compliance record is evidence rather than a UI feature.',
    },
  ],
};

/**
 * What it would be appointed as, if the blocking findings were cleared.
 *
 * Note the deliberate narrowness. A privacy tool holding a named person's PII
 * is the last application that should hold broad scopes, and the first that
 * should be able to prove it holds none it does not need.
 */
export const ONE_CLICK_APPOINTMENT = {
  appId: 'one-click-purge',
  governedBy: 'V12 Apex Atlas',
  realm: 'apex-galaxy',
  role: 'privacy-and-erasure',
  capabilities: ['footprint-scanning', 'erasure-request-generation', 'permission-inventory'],
  /**
   * No scopes at all on admission.
   *
   * Apex holds media inventory, a production twin and a decision record. A
   * privacy tool has no business reading any of them, and the correct starting
   * grant for an application whose whole purpose is minimising data exposure is
   * nothing. Widen later, per route, with a reason.
   */
  externalScopes: [] as const,
  withheldScopes: ['inventory:read', 'twin:read', 'valuation:read', 'audit:read', 'webhook:receive'] as const,
} as const;
