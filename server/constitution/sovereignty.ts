/**
 * APEX ATLAS IS SOVEREIGN. ITS INSPECTORATE IS ITS OWN.
 *
 * Apex Atlas is part of V12 Multimedia. It is NOT part of the ecosystem. Those
 * are different statements and the difference is the whole of this file:
 *
 *   - It seats its own Inspector Generals, and they are the only body that can
 *     certify an Apex release.
 *   - It never asks Nexion, Orion Prime, or any other party for a Certificate.
 *   - It can HOST the ecosystem — run the registry and broker inside itself —
 *     without thereby becoming governed by it.
 *
 * I had queued a change to point Apex's certification at Nexion's Inspectorate,
 * on the reasoning that two Inspectorates make Article XIII §13.1's
 * independence claim meaningless. That reasoning was wrong, and the correction
 * is worth stating because it is easy to make again.
 *
 * §13.1 requires the Inspectorate to be independent of "every agent, every
 * application, every product line and every commercial objective IN THE
 * ECOSYSTEM". Nexion's Inspectorate is independent within the ecosystem. Apex
 * is outside that ecosystem, so deferring to Nexion would not have satisfied
 * §13.1 — it would have INVERTED it, making a body that answers to the
 * ecosystem the gate on an entity the ecosystem does not govern. One
 * Inspectorate per sovereign, not one Inspectorate total.
 *
 * The practical consequence, and the reason this is a module rather than a
 * comment: there must be no code path by which a remote party certifies an Apex
 * release. Not a configuration option, not a fallback for when local quorum is
 * unavailable, not a "trusted federation" flag. Below quorum Apex releases
 * nothing — it does not go looking for someone else to ask.
 */

import type { CertificateOfRelease, ReleaseCandidate } from './types';
import type { Inspectorate } from './release';

/** Who Apex is, constitutionally. */
export const SOVEREIGN = {
  entity: 'V12 Apex Atlas',
  parent: 'V12 Multimedia',
  /**
   * Apex is under V12 Multimedia and outside the v12-ecosystem. It may host the
   * ecosystem, integrate with it, and refuse it — none of which make it a
   * member.
   */
  memberOfEcosystem: false,
  inspectorate: 'own',
} as const;

export type CertificationSource = 'local-sovereign';

/**
 * The only certification path Apex has.
 *
 * The return type names its own source, and there is exactly one value it can
 * take. If a future change adds a second source, every call site stops
 * compiling — which is the point. A remote-certification feature should be
 * impossible to add by accident, and expensive enough to add on purpose that
 * somebody has to argue for it.
 */
export interface SovereignCertification {
  source: CertificationSource;
  certificate: CertificateOfRelease;
}

export type SovereignRefusal =
  | { refused: 'below_quorum'; seated: number; required: number; detail: string }
  | { refused: 'not_certified'; detail: string };

export type SovereignOutcome = { certified: true; result: SovereignCertification } | { certified: false } & SovereignRefusal;

/**
 * Certify a release using APEX'S OWN Inspectorate, or refuse.
 *
 * Note what this function does not take as a parameter: a URL, a remote
 * inspectorate, a federation peer, a fallback. It cannot reach the network. Its
 * only inputs are Apex's own seat register and the candidate.
 */
export function certifySovereign(
  inspectorate: Inspectorate,
  candidate: ReleaseCandidate,
  now: number = Date.now(),
): SovereignOutcome {
  if (!inspectorate.hasQuorum) {
    const seated = inspectorate.seated.length;
    return {
      certified: false,
      refused: 'below_quorum',
      seated,
      required: 3,
      detail:
        `Apex Atlas seats its own Inspectorate and ${seated} of 3 are seated. Below quorum it issues nothing ` +
        '(Article XIII §13.4). It does NOT fall back to another party\'s Inspectorate: Apex is outside the ' +
        'ecosystem, so an ecosystem body certifying an Apex release would invert §13.1 rather than satisfy it.',
    };
  }

  const outcome = inspectorate.certify(candidate, now);
  if (!outcome.released) {
    return { certified: false, refused: 'not_certified', detail: `${outcome.reason}: ${outcome.detail}` };
  }

  return { certified: true, result: { source: 'local-sovereign', certificate: outcome.certificate } };
}

/**
 * Guard for the inbound direction: a peer offering Apex a certificate.
 *
 * The ecosystem may legitimately send Apex an execution record, evidence, or a
 * request. It may not send Apex permission. This exists because the attack is
 * so cheap — a compromised or merely over-helpful peer attaching a
 * `certificate` field to a relay body, and an Apex handler reading it because
 * the shape matched.
 */
export function refuseForeignCertificate(payload: unknown): { ok: true } | { ok: false; reason: string } {
  if (!payload || typeof payload !== 'object') return { ok: true };

  const suspicious = ['certificate', 'certificateOfRelease', 'certificate_of_release', 'releaseCertificate', 'inspectorate'];
  const found: string[] = [];

  const scan = (node: unknown, depth = 0): void => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (suspicious.includes(key)) found.push(key);
      scan(child, depth + 1);
    }
  };
  scan(payload);

  if (found.length > 0) {
    return {
      ok: false,
      reason:
        `An inbound payload carries ${found.join(', ')}. Apex Atlas certifies its own releases and accepts no ` +
        'certificate from any external party. The ecosystem may send Apex facts; it may not send Apex permission.',
    };
  }
  return { ok: true };
}
