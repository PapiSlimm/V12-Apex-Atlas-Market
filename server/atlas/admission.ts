/**
 * Atlas admission — Apex Atlas deciding what may enter the Galaxy.
 *
 * Article IX §9.2(4–5): ApexAtlas reviews a completed record for admission, and
 * only on Apex acceptance may data journey into the Atlas Galaxy. §9.3: an Apex
 * refusal is not appealable by any agent.
 *
 * That authority is worth nothing if it is exercised by reading a self-declared
 * manifest. An application asking to enter the Galaxy is asking for its data to
 * be commingled with the long-horizon commons, so the question is not "what
 * does it say it does" but "what does its code actually do to money, tenancy
 * and the audit trail".
 *
 * THE ENTRENCHED ARTICLES ARE THE ADMISSION BAR
 * ---------------------------------------------
 * Articles I, II, III, VII, X, XII and XIII may be tightened and never
 * weakened. An applicant that violates one of them cannot be admitted
 * conditionally, waived in, or admitted "pending remediation", because there is
 * no lawful state in which the violation is acceptable. Everything else is a
 * condition.
 *
 * This module is deterministic. It takes findings that a human or a reviewer
 * established by reading source, and applies the rules. It does not read source
 * itself and does not ask a model — Article I §1.4.
 */

export type ArticleRef =
  | 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI' | 'VII' | 'VIII' | 'IX' | 'X' | 'XI' | 'XII' | 'XIII';

/** Article XII §12.4. Tightened, never weakened — so never waived for admission. */
export const ENTRENCHED: ArticleRef[] = ['I', 'II', 'III', 'VII', 'X', 'XII', 'XIII'];

export interface AdmissionFinding {
  article: ArticleRef;
  section: string;
  /** What the applicant's code actually does. Observed, not declared. */
  observed: string;
  /** Where it was observed, so the finding is checkable. */
  evidence: string;
  /** What would satisfy the Article. */
  remedy: string;
  /**
   * Set when the finding harms the END USER rather than the estate.
   *
   * Added while assessing One-Click Data Purge, which reports erasure requests
   * and OAuth revocations that never happened. Constitutionally that is one
   * Schedule A8 finding among several; in practice it is the only one that
   * hurts a person, because someone who believes their tokens are revoked stops
   * taking the real action. A dossier that ranks it alongside a missing hash
   * chain has buried the thing that matters.
   */
  subjectHarm?: string;
}

export interface AdmissionCandidate {
  appId: string;
  name: string;
  /** What it offers, from its own code rather than its marketing. */
  services: string[];
  /** Data classes it holds. Determines what admission would commingle. */
  resources: string[];
  findings: AdmissionFinding[];
}

export type AdmissionVerdict = 'ADMITTED' | 'ADMITTED_WITH_CONDITIONS' | 'REFUSED';

export interface AdmissionDecision {
  verdict: AdmissionVerdict;
  /** §9.3 — an Apex refusal is not appealable by any agent. */
  appealable: false;
  blocking: AdmissionFinding[];
  conditions: AdmissionFinding[];
  reason: string;
  /** What the applicant may do in the meantime. Refusal is not exile. */
  interim: string;
}

export function isEntrenched(article: ArticleRef): boolean {
  return ENTRENCHED.includes(article);
}

/**
 * Decide.
 *
 * A candidate with no findings is admitted. A candidate whose only findings are
 * on non-entrenched Articles is admitted with those as conditions — it enters,
 * and the conditions are tracked. A candidate that violates an entrenched
 * Article is refused, and no number of compensating controls changes that.
 */
export function assessAdmission(candidate: AdmissionCandidate): AdmissionDecision {
  const blocking = candidate.findings.filter((f) => isEntrenched(f.article));
  const conditions = candidate.findings.filter((f) => !isEntrenched(f.article));

  if (blocking.length > 0) {
    const articles = [...new Set(blocking.map((f) => `Article ${f.article} ${f.section}`))];
    return {
      verdict: 'REFUSED',
      appealable: false,
      blocking,
      conditions,
      reason:
        `${candidate.name} violates ${blocking.length} requirement(s) under entrenched Articles: ` +
        `${articles.join('; ')}. An entrenched Article may be tightened and never weakened (Article XII §12.4), ` +
        'so there is no lawful state in which these are acceptable and no conditional admission is available. ' +
        'This refusal is not appealable by any agent (Article IX §9.3); resubmission requires a material ' +
        'change of facts, recorded as such.',
      interim:
        'The data terminates at the ecosystem boundary and is retained locally under the tenant\'s own ' +
        'retention policy. The applicant may continue to operate independently, and may hold a scoped ' +
        'external integration key against Apex\'s read-only /api/v1 surface, which commingles nothing.',
    };
  }

  if (conditions.length > 0) {
    return {
      verdict: 'ADMITTED_WITH_CONDITIONS',
      appealable: false,
      blocking: [],
      conditions,
      reason:
        `${candidate.name} satisfies every entrenched Article. ${conditions.length} condition(s) remain on ` +
        'non-entrenched Articles and are recorded against the admission rather than blocking it.',
      interim: 'Admitted. Conditions are tracked and their breach is an ordinary violation under Article XI.',
    };
  }

  return {
    verdict: 'ADMITTED',
    appealable: false,
    blocking: [],
    conditions: [],
    reason: `${candidate.name} satisfies every Article assessed.`,
    interim: 'Admitted without conditions.',
  };
}

/** A dossier a human can read and check, in the order that matters. */
export function renderDossier(candidate: AdmissionCandidate, decision: AdmissionDecision): string {
  const lines: string[] = [
    `ATLAS ADMISSION — ${candidate.name} (${candidate.appId})`,
    '='.repeat(60),
    '',
    `VERDICT   ${decision.verdict}`,
    `APPEALABLE ${decision.appealable ? 'yes' : 'no — Article IX §9.3'}`,
    '',
    `Services   ${candidate.services.join(', ')}`,
    `Resources  ${candidate.resources.join(', ')}`,
    '',
    decision.reason,
    '',
  ];

  const harmful = candidate.findings.filter((f) => f.subjectHarm);
  if (harmful.length > 0) {
    lines.push('HARM TO THE PERSON — read this first', '-'.repeat(60));
    for (const f of harmful) {
      lines.push(`  Article ${f.article} ${f.section}`, `    ${f.subjectHarm}`, '');
    }
  }

  if (decision.blocking.length > 0) {
    lines.push('BLOCKING — entrenched Articles, not waivable', '-'.repeat(60));
    for (const f of decision.blocking) {
      lines.push(
        `  Article ${f.article} ${f.section}`,
        `    observed  ${f.observed}`,
        `    evidence  ${f.evidence}`,
        `    remedy    ${f.remedy}`,
        '',
      );
    }
  }

  if (decision.conditions.length > 0) {
    lines.push('CONDITIONS — recorded, not blocking', '-'.repeat(60));
    for (const f of decision.conditions) {
      lines.push(`  Article ${f.article} ${f.section} — ${f.observed}`, `    remedy  ${f.remedy}`, '');
    }
  }

  lines.push('IN THE MEANTIME', '-'.repeat(60), `  ${decision.interim}`);
  return lines.join('\n');
}
