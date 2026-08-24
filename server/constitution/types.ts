/**
 * V12-CONST-001 — shared types.
 *
 * Every type here exists to make a constitutional requirement expressible in
 * the type system rather than in a comment. Where the Constitution says an
 * action carries a rationale, `rationale` is required and not optional; where
 * it says a receipt is bound to one tenant, the binding is a field, not a
 * convention.
 */

/** Article XI §11.1, in ascending order. The index is the escalation rank. */
export const SEVERITIES = ['advisory', 'moderate', 'serious', 'critical', 'catastrophic'] as const;
export type Severity = (typeof SEVERITIES)[number];

export type Sanction = 'WARN' | 'THROTTLE' | 'SUSPEND_AGENT' | 'QUARANTINE_TENANT' | 'HALT_ECOSYSTEM';

/** A citation, so no denial is ever unexplained. Article V applies to the engine too. */
export interface Citation {
  article: string;
  section: string;
  /** Plain language, for a competent finance officer who is not an engineer. */
  requirement: string;
}

export interface Violation {
  severity: Severity;
  citation: Citation;
  /** Who did it. Article XI §11.4 requires the responsible agent identity. */
  agentId: string;
  tenantId: string;
  /** SHA-256 of the payload that occasioned the violation. */
  payloadDigest: string;
  detail: string;
  at: number;
}

export type Decision =
  | { allowed: true; rationale: string }
  | { allowed: false; violation: Violation; sanction: Sanction };

/**
 * Article V. A rationale is recorded BEFORE the action clears, so it is an
 * input to the decision, never a field filled in afterwards.
 */
export interface Rationale {
  /** What changed, by how much. */
  summary: string;
  /** The specific inputs relied upon (§5.3). */
  inputs: Record<string, string | number>;
  /** The specific threshold applied (§5.3). */
  threshold: { name: string; value: string | number };
  /** BCP-47. §5.1 requires the tenant's language. */
  language: string;
}

/** Article XIII §13.3 — the exhaustive list of what counts as a release. */
export type ReleaseKind =
  | 'public_feed_publication'
  | 'campaign_or_price_change'
  | 'atlas_galaxy_transit'
  | 'cross_application_feed_share'
  | 'firewall_ruleset_change'
  | 'agent_capability_change'
  | 'production_deployment'
  | 'constitutional_amendment'
  | 'rmpm_public_assertion';

export type RiskClass = 'ordinary' | 'entrenched' | 'critical' | 'catastrophic' | 'amendment';

export interface ReleaseCandidate {
  id: string;
  kind: ReleaseKind;
  risk: RiskClass;
  tenantId: string;
  /** The agent asking. §13.10 — it can never also be the issuer. */
  proposedBy: string;
  payloadDigest: string;
  rationale: Rationale;
  /** Required only for cross-application feed share. §13.11 / §13.12. */
  destinations?: string[];
}

/**
 * An Inspector General.
 *
 * §13.5: never an agent. That is enforced by the fact that a seat is a PUBLIC
 * key whose private half is held by a person out of band — the engine cannot
 * mint a signature and neither can any agent in the estate. The `kind` field is
 * a label; the keypair is the control.
 */
export interface InspectorGeneral {
  id: string;
  name: string;
  kind: 'human';
  /** Ed25519 SPKI, base64. */
  publicKey: string;
  seatedAt: number;
}

export interface Determination {
  inspectorId: string;
  concurs: boolean;
  /** §13.6 — a vacuous reason may be rejected. */
  reasons: string;
  at: number;
  /** Ed25519 over the canonical determination string. */
  signature: string;
}

/** §13.7 — immutable, and the only evidence that a review happened. */
export interface Dossier {
  candidateId: string;
  payloadDigest: string;
  openedAt: number;
  /** §13.8 — expiry is refusal, never deemed consent. */
  expiresAt: number;
  determinations: Determination[];
  disposition: 'pending' | 'certified' | 'refused' | 'expired';
  seatedAtOpen: number;
}

/** §13.2 — the thing without which nothing releases. Single-use, time-limited. */
export interface CertificateOfRelease {
  candidateId: string;
  payloadDigest: string;
  issuedAt: number;
  expiresAt: number;
  /** The IGs who concurred. Never includes the proposer (§13.9, §13.10). */
  concurringInspectors: string[];
  /** §13.12 — per destination, each on its own facts. */
  cityWorldClearances?: Record<string, boolean>;
  serial: string;
}

/** Article IV §4.5 — bound to one SKU, one ceiling, one tenant, one expiry. */
export interface AuthorisationReceipt {
  serial: string;
  tenantId: string;
  sku: string;
  ceilingMinorUnits: bigint;
  verdict: 'APPROVED' | 'PARTIAL_MODERATED_APPROVAL';
  /** §4.4 — recorded so self-authorisation is detectable after the fact too. */
  requestedBy: string;
  authorisedBy: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export class ConstitutionalViolation extends Error {
  constructor(
    readonly violation: Violation,
    readonly sanction: Sanction,
  ) {
    super(`${violation.citation.article} ${violation.citation.section}: ${violation.detail}`);
    this.name = 'ConstitutionalViolation';
  }
}

export function cite(article: string, section: string, requirement: string): Citation {
  return { article, section, requirement };
}
