/**
 * Article XI — the sanctions ladder.
 *
 * Sanctions are applied "automatically and immediately by the enforcement
 * engine" (§11.1). Not proposed. Not queued for review. The function that
 * detects a violation is the function that applies the sanction, because any
 * gap between the two is a window in which the action proceeds.
 *
 * §11.3 is the load-bearing one: an agent may not lift, reduce, appeal or
 * expire its own sanction. There is therefore no public method here that takes
 * an agent identity and removes that agent's sanction. Lifting is a human act
 * performed through `liftByHuman`, which requires an operator identity that no
 * agent possesses.
 */

import crypto from 'crypto';
import type { ConstitutionDocument } from './anchor';
import { SEVERITIES, type Sanction, type Severity, type Violation } from './types';

export interface SanctionRecord {
  agentId: string;
  tenantId: string;
  sanction: Sanction;
  severity: Severity;
  appliedAt: number;
  /** Null means it does not expire on its own — a human must lift it. */
  expiresAt: number | null;
  citation: string;
}

export type AuditSink = (event: {
  type: 'constitution.violation' | 'constitution.sanction';
  severity: Severity;
  article: string;
  section: string;
  agentId: string;
  tenantId: string;
  payloadDigest: string;
  detail: string;
  sanction?: Sanction;
}) => void;

/**
 * §11.2 escalation state.
 *
 * KNOWN LIMIT, stated rather than discovered: this counter is per-process. Two
 * instances would each count to three separately, so an agent could commit five
 * advisory violations across two nodes without escalating. It moves to shared
 * storage before a second instance runs — the same constraint the rate limiter
 * and kill switch already carry, and `preflight` says so.
 */
interface Tally {
  severity: Severity;
  timestamps: number[];
}

export class SanctionsEngine {
  private readonly tallies = new Map<string, Tally>();
  private readonly active = new Map<string, SanctionRecord>();
  private ecosystemHalted = false;

  constructor(
    private readonly doc: ConstitutionDocument,
    private readonly audit: AuditSink,
  ) {}

  /** §11.1 — the ladder, read from the anchored document rather than hard-coded. */
  sanctionFor(severity: Severity): Sanction {
    return this.doc.sanctions[severity].sanction as Sanction;
  }

  deniesAction(severity: Severity): boolean {
    return this.doc.sanctions[severity].denies_action;
  }

  /**
   * Record a violation and apply its sanction, escalating if §11.2 is met.
   * Returns the sanction actually applied, which may be harsher than the
   * severity passed in.
   */
  apply(violation: Violation): { sanction: Sanction; effective: Severity } {
    const effective = this.escalate(violation.agentId, violation.severity, violation.at);
    const sanction = this.sanctionFor(effective);

    this.audit({
      type: 'constitution.violation',
      severity: effective,
      article: violation.citation.article,
      section: violation.citation.section,
      agentId: violation.agentId,
      tenantId: violation.tenantId,
      payloadDigest: violation.payloadDigest,
      detail: violation.detail,
      sanction,
    });

    const key = `${violation.tenantId}:${violation.agentId}`;
    const record: SanctionRecord = {
      agentId: violation.agentId,
      tenantId: violation.tenantId,
      sanction,
      severity: effective,
      appliedAt: violation.at,
      expiresAt: this.expiryFor(sanction, violation.at),
      citation: `${violation.citation.article} ${violation.citation.section}`,
    };

    // Only ever replace with something at least as severe. A later advisory
    // must not quietly clear a standing suspension.
    const existing = this.active.get(key);
    if (!existing || SEVERITIES.indexOf(effective) >= SEVERITIES.indexOf(existing.severity)) {
      this.active.set(key, record);
    }

    if (sanction === 'HALT_ECOSYSTEM') {
      this.ecosystemHalted = true;
    }

    return { sanction, effective };
  }

  /**
   * §11.2 — three of one severity within the window becomes the next rung.
   * Automatic, and an agent cannot reset it: nothing here takes input from the
   * agent being counted.
   */
  private escalate(agentId: string, severity: Severity, now: number): Severity {
    const next = this.doc.escalation.ladder[severity] as Severity | undefined;
    if (!next) return severity;

    const key = `${agentId}:${severity}`;
    const windowMs = this.doc.escalation.window_hours * 3_600_000;
    const tally = this.tallies.get(key) ?? { severity, timestamps: [] };

    tally.timestamps = tally.timestamps.filter((t) => now - t < windowMs);
    tally.timestamps.push(now);
    this.tallies.set(key, tally);

    if (tally.timestamps.length >= this.doc.escalation.count) {
      // The rung is consumed so the next three escalate again rather than every
      // subsequent violation inheriting the escalation permanently.
      tally.timestamps = [];
      return next;
    }
    return severity;
  }

  private expiryFor(sanction: Sanction, at: number): number | null {
    if (sanction === 'THROTTLE') {
      const minutes = Number(this.doc.sanctions.moderate.throttle_minutes ?? 60);
      return at + minutes * 60_000;
    }
    // SUSPEND, QUARANTINE and HALT do not time out. §11.3 — an agent cannot
    // wait out its own suspension.
    return null;
  }

  /** Is this agent currently permitted to act at all? */
  statusOf(tenantId: string, agentId: string, now: number = Date.now()): SanctionRecord | null {
    if (this.ecosystemHalted) {
      return {
        agentId,
        tenantId,
        sanction: 'HALT_ECOSYSTEM',
        severity: 'catastrophic',
        appliedAt: now,
        expiresAt: null,
        citation: 'Article XI §11.1',
      };
    }
    const record = this.active.get(`${tenantId}:${agentId}`);
    if (!record) return null;
    if (record.expiresAt !== null && now >= record.expiresAt) {
      this.active.delete(`${tenantId}:${agentId}`);
      return null;
    }
    return record;
  }

  get halted(): boolean {
    return this.ecosystemHalted;
  }

  /**
   * §11.3 / Article X — lifting is a HUMAN act.
   *
   * The operator identity is required and unused for anything except the audit
   * record, which is the point: there is no code path that lifts a sanction
   * without naming a person. An agent calling this would have to invent an
   * operator, and that invention is what the audit trail catches.
   */
  liftByHuman(tenantId: string, agentId: string, operator: string, justification: string): boolean {
    if (!operator.trim() || !justification.trim()) return false;
    const key = `${tenantId}:${agentId}`;
    const record = this.active.get(key);
    if (!record) return false;

    this.active.delete(key);
    if (record.sanction === 'HALT_ECOSYSTEM') this.ecosystemHalted = false;

    this.audit({
      type: 'constitution.sanction',
      severity: record.severity,
      article: 'XI',
      section: '§11.3',
      agentId,
      tenantId,
      payloadDigest: crypto.createHash('sha256').update(justification).digest('hex'),
      detail: `Sanction ${record.sanction} lifted by human operator ${operator}: ${justification}`,
    });
    return true;
  }
}
