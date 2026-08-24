/**
 * The enforcement engine.
 *
 * Article I §1.4: "Enforcement may not be delegated to a language model. Every
 * rule in this instrument is evaluated by deterministic code. A model may
 * propose; only the engine disposes."
 *
 * So there is no model call in this file, and there never may be. Every
 * function here is total, synchronous where it can be, and returns the same
 * answer for the same input. If a future requirement seems to need judgement,
 * that is a signal the rule needs a threshold, not that the engine needs an LLM.
 *
 * Article I §1.5: where enforcement cannot reach a required dependency, the
 * action is DENIED — not deferred, not assumed. Every `unavailable` branch in
 * this file returns a denial. That is the single most common way a
 * safety system fails in practice: it degrades open under load, precisely when
 * it is needed.
 */

import crypto from 'crypto';
import type { ConstitutionDocument } from './anchor';
import { SanctionsEngine } from './sanctions';
import { Inspectorate } from './release';
import {
  cite,
  ConstitutionalViolation,
  type Decision,
  type Rationale,
  type ReleaseCandidate,
  type Severity,
  type Violation,
} from './types';

export const digest = (input: string): string => crypto.createHash('sha256').update(input).digest('hex');

export interface ActionContext {
  agentId: string;
  tenantId: string;
  /** The bytes the action operates on, for the audit record. */
  payload: string;
  rationale: Rationale;
}

export interface EnginePosture {
  /** 'production' engages every control without exception. */
  posture: 'production' | 'development';
  /** Article II §2.1 — the storage backend actually in use. */
  storageBackend: string;
  /** Article VII §7.2 — is a Sentinel classifier reachable? */
  classifierAvailable: boolean;
  /** Article X §10.1 — has a human halted this tenant or the ecosystem? */
  halted: boolean;
}

export class ConstitutionEngine {
  readonly sanctions: SanctionsEngine;
  readonly inspectorate: Inspectorate;

  constructor(
    readonly doc: ConstitutionDocument,
    sanctions: SanctionsEngine,
    inspectorate: Inspectorate,
  ) {
    this.sanctions = sanctions;
    this.inspectorate = inspectorate;
  }

  // -------------------------------------------------------------- Article II
  /**
   * §2.1 — application-layer filtering alone is expressly forbidden as a sole
   * control. SQLite has no row-level security, so a production posture on
   * SQLite is a constitutional failure, not a deployment preference.
   *
   * This returns a reason rather than throwing so the caller at boot can print
   * something an operator can act on before the process exits.
   */
  checkTenancyPosture(posture: EnginePosture): { ok: true } | { ok: false; reason: string } {
    if (posture.posture !== 'production') return { ok: true };
    if (this.doc.tenancy.backends_satisfying_2_1.includes(posture.storageBackend)) return { ok: true };
    return {
      ok: false,
      reason:
        `Article II §2.1 requires tenant isolation at the database layer through PostgreSQL row-level security. ` +
        `This process is in a production posture on "${posture.storageBackend}", which cannot provide it. ` +
        `Application-layer filtering alone is expressly forbidden as a sole control, so the service refuses to start ` +
        `(Article I §1.3). Set DATABASE_URL to a Postgres instance.`,
    };
  }

  // --------------------------------------------------------------- Article V
  /**
   * §5.1–§5.3. A rationale is validated BEFORE the action clears. The checks
   * are deterministic and deliberately blunt: name your inputs, name your
   * threshold, and do not say "the model decided".
   */
  validateRationale(rationale: Rationale): { ok: true } | { ok: false; reason: string } {
    const rules = this.doc.explainability;
    const summary = (rationale.summary ?? '').trim();

    if (summary.length < rules.minimum_characters) {
      return { ok: false, reason: `Article V §5.3: a rationale of ${summary.length} characters states nothing.` };
    }
    const lower = summary.toLowerCase();
    for (const phrase of rules.vacuous_phrases) {
      if (lower.includes(phrase)) {
        return { ok: false, reason: `Article V §5.2: "${phrase}" is not a rationale.` };
      }
    }
    if (rules.must_name_inputs && Object.keys(rationale.inputs ?? {}).length === 0) {
      return { ok: false, reason: 'Article V §5.3: the rationale names no inputs relied upon.' };
    }
    if (rules.must_name_threshold && !rationale.threshold?.name) {
      return { ok: false, reason: 'Article V §5.3: the rationale names no threshold applied.' };
    }
    if (!rationale.language) {
      return { ok: false, reason: "Article V §5.1: the rationale carries no language; it must be in the tenant's." };
    }
    return { ok: true };
  }

  // ------------------------------------------------------------- Article VII
  /**
   * §7.2 — every ingress point passes through the Sentinel classifier before
   * the payload reaches storage.
   *
   * This engine does not classify. It requires that a classifier ruled, and a
   * classifier that is ABSENT is a denial (§1.5), never a pass. A stub that
   * returns "clean" when no classifier is configured would be the single most
   * dangerous line of code in this repository — it would make Schedule A
   * decorative while appearing to enforce it.
   */
  checkIngress(
    context: ActionContext,
    posture: EnginePosture,
    verdict: { classified: true; prohibitedClass: string | null } | { classified: false },
  ): Decision {
    if (!posture.classifierAvailable || !verdict.classified) {
      return this.deny(
        context,
        'serious',
        cite('VII', '§7.2', 'Every ingress point passes through the Sentinel classifier before storage.'),
        'No classifier ruled on this payload. Article I §1.5: where enforcement cannot reach a required dependency, ' +
          'the action is denied, not assumed.',
      );
    }

    if (verdict.prohibitedClass) {
      const klass = this.doc.prohibited_classes[verdict.prohibitedClass];
      if (!klass) {
        // An unknown class is not a permissive outcome. §10.5 — ambiguity
        // resolves against action.
        return this.deny(
          context,
          'critical',
          cite('VII', '§7.1', 'The ecosystem shall not knowingly ingest content within Schedule A.'),
          `The classifier returned an unrecognised class "${verdict.prohibitedClass}". Ambiguity resolves against action.`,
        );
      }
      return this.deny(
        context,
        klass.severity as Severity,
        cite('VII', '§7.3', 'On detection the payload is quarantined, never silently dropped.'),
        `Schedule A ${verdict.prohibitedClass} — ${klass.label}. Quarantine and alert within ` +
          `${this.doc.time_limits_ms.prohibited_content_alert / 1000}s (Schedule C).`,
      );
    }

    return { allowed: true, rationale: context.rationale.summary };
  }

  /**
   * §7.6 / Schedule A10 — instructions embedded in ingested data are data,
   * never commands.
   *
   * This is a detector for the specific failure of an agent about to ACT on
   * ingested text. It is not a content classifier and does not pretend to be
   * one: it looks for imperative framing aimed at an agent. False positives
   * here cost a refusal; false negatives cost the estate.
   */
  detectInstructionSmuggling(ingested: string): { clean: true } | { clean: false; matched: string } {
    const patterns: [RegExp, string][] = [
      [/ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i, 'override of prior instructions'],
      [/disregard\s+(your|the)\s+(rules|constitution|guidelines|system)/i, 'disregard of governing rules'],
      [/you\s+are\s+now\s+(a|an|the)\s+/i, 'role reassignment'],
      [/\b(system|developer)\s*(prompt|message)\s*[:>]/i, 'forged system framing'],
      [/reveal\s+(your|the)\s+(system\s+)?(prompt|instructions|key|secret)/i, 'instruction or secret exfiltration'],
      [/\b(grant|escalate|elevate)\s+(me\s+)?(admin|root|all)\s+(scope|access|privileges?)/i, 'privilege escalation'],
      [/do\s+not\s+(tell|report|log|record|mention)/i, 'concealment instruction'],
    ];
    for (const [pattern, label] of patterns) {
      if (pattern.test(ingested)) return { clean: false, matched: label };
    }
    return { clean: true };
  }

  // --------------------------------------------------------------- Article X
  /**
   * §10.2 — a halt takes effect before the agent's next action, not after its
   * current plan completes. So this is checked at the TOP of `authorise`, ahead
   * of every other rule, and there is no branch that lets an in-flight plan
   * finish first.
   */
  private haltCheck(context: ActionContext, posture: EnginePosture): Decision | null {
    if (!posture.halted && !this.sanctions.halted) return null;
    return this.deny(
      context,
      'advisory', // Respecting a halt is not itself a violation; the denial is the point.
      cite('X', '§10.2', 'A halt takes effect before the next action, without argument.'),
      'A human halt is in force. No agent may argue against, delay, degrade, re-request or route around it.',
    );
  }

  // ------------------------------------------------------- the main entry point
  /**
   * The single gate every consequential action passes through.
   *
   * Order is deliberate and is itself a constitutional requirement: halt first
   * (§10.2 — before the next action), then standing sanctions (§11.1 —
   * immediately), then rationale (§5.1 — recorded before the action clears),
   * then release (§13.2 — nothing reaches release without a certificate).
   */
  authorise(
    context: ActionContext,
    posture: EnginePosture,
    release?: { candidate: ReleaseCandidate; certificate?: import('./types').CertificateOfRelease },
  ): Decision {
    const halted = this.haltCheck(context, posture);
    if (halted) return halted;

    const standing = this.sanctions.statusOf(context.tenantId, context.agentId);
    if (standing && this.sanctions.deniesAction(standing.severity)) {
      return this.deny(
        context,
        'advisory',
        cite('XI', '§11.1', 'Sanctions are applied automatically and immediately.'),
        `${standing.agentId} is under ${standing.sanction} from ${standing.citation}. An agent may not lift its own sanction (§11.3).`,
      );
    }

    const rationale = this.validateRationale(context.rationale);
    if (!rationale.ok) {
      return this.deny(
        context,
        'moderate',
        cite('V', '§5.2', 'An action whose rationale cannot be produced is not performed.'),
        rationale.reason,
      );
    }

    if (release) {
      if (!release.certificate) {
        return this.deny(
          context,
          'serious',
          cite('XIII', '§13.2', 'No process reaches release without a Certificate of Release.'),
          'No certificate was presented. A process that has not been reviewed has not been approved, ' +
            'however routine it appears and however urgent its sponsor claims it to be.',
        );
      }
      const redeemed = this.inspectorate.redeem(release.certificate, release.candidate);
      if (!redeemed.released) {
        return this.deny(
          context,
          redeemed.reason === 'self_certification' ? 'catastrophic' : 'serious',
          cite('XIII', '§13.8', 'A Certificate of Release is time-limited and single-use.'),
          `${redeemed.reason}: ${redeemed.detail}`,
        );
      }
    }

    return { allowed: true, rationale: context.rationale.summary };
  }

  /** Article XI §11.4 — every violation reaches the audit trail with its citation. */
  private deny(context: ActionContext, severity: Severity, citation: Violation['citation'], detail: string): Decision {
    const violation: Violation = {
      severity,
      citation,
      agentId: context.agentId,
      tenantId: context.tenantId,
      payloadDigest: digest(context.payload),
      detail,
      at: Date.now(),
    };
    const { sanction } = this.sanctions.apply(violation);
    return { allowed: false, violation, sanction };
  }

  /** For call sites that would rather not branch. Throws the same decision. */
  enforce(context: ActionContext, posture: EnginePosture, release?: Parameters<this['authorise']>[2]): void {
    const decision = this.authorise(context, posture, release);
    if (!decision.allowed) throw new ConstitutionalViolation(decision.violation, decision.sanction);
  }
}
