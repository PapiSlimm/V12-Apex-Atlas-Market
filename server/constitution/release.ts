/**
 * Article XIII — the Superior Inspectorate General, and the gate nothing passes
 * without.
 *
 * THE ONE DESIGN DECISION THAT MATTERS HERE
 * -----------------------------------------
 * §13.5 says an Inspector General is never an agent, and §13.10 says no process
 * may certify itself. Both are unenforceable if a Certificate of Release is
 * just a record this process writes — any code that can write a certificate can
 * write itself a certificate, and a boolean field saying `kind: 'human'` is a
 * label an agent can also write.
 *
 * So a certificate is not a record. **It is a collection of Ed25519 signatures
 * produced by keys this system does not hold.** Seats carry public keys only.
 * Determinations are signed out of band by the people holding the private
 * halves. At redemption the engine re-verifies every signature against the seat
 * register. There is no code path in this repository that can manufacture a
 * concurrence, because there is no private key here to manufacture it with —
 * exactly the property that made the Orion registry safe.
 *
 * That is the difference between a constitution that is enforced and a
 * constitution that is merely described.
 *
 * WHAT THIS MEANS IN PRACTICE
 * ---------------------------
 * With no seats registered, this system releases NOTHING. That is §13.4's
 * "below quorum, the Inspectorate issues nothing and every release is refused",
 * working as written. It is not a misconfiguration to be worked around before
 * launch; it is the gate. Seating three Inspector Generals is a human act,
 * performed with `npm run constitution:seat`.
 */

import crypto from 'crypto';
import type {
  CertificateOfRelease,
  Determination,
  Dossier,
  InspectorGeneral,
  ReleaseCandidate,
  RiskClass,
} from './types';
import type { ConstitutionDocument } from './anchor';

export type ReleaseRefusal =
  | 'no_certificate'
  | 'below_quorum'
  | 'insufficient_concurrence'
  | 'certificate_expired'
  | 'certificate_spent'
  | 'digest_mismatch'
  | 'candidate_mismatch'
  | 'signature_invalid'
  | 'unseated_inspector'
  | 'self_certification'
  | 'conflict_of_interest'
  | 'destination_not_cleared'
  | 'review_window_expired';

export type ReleaseOutcome =
  | { released: true; certificate: CertificateOfRelease }
  | { released: false; reason: ReleaseRefusal; detail: string };

/** The bytes an Inspector General signs. Stable, ordered, unambiguous. */
export function determinationCanonical(parts: {
  candidateId: string;
  payloadDigest: string;
  inspectorId: string;
  concurs: boolean;
  reasons: string;
  at: number;
}): string {
  return [
    'v12-const-001-determination',
    parts.candidateId,
    parts.payloadDigest,
    parts.inspectorId,
    parts.concurs ? 'CONCUR' : 'REFUSE',
    crypto.createHash('sha256').update(parts.reasons).digest('hex'),
    String(parts.at),
  ].join('\n');
}

function verifyDetermination(determination: Determination, candidate: ReleaseCandidate, publicKey: string): boolean {
  const canonical = determinationCanonical({
    candidateId: candidate.id,
    payloadDigest: candidate.payloadDigest,
    inspectorId: determination.inspectorId,
    concurs: determination.concurs,
    reasons: determination.reasons,
    at: determination.at,
  });
  try {
    return crypto.verify(
      null,
      Buffer.from(canonical, 'utf8'),
      crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }),
      Buffer.from(determination.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/** §13.6 — a reason that says nothing may be rejected. Deterministic, not a judgement call. */
const VACUOUS = /^(ok|fine|lgtm|approved|yes|no|looks good|sure|\W*)$/i;
function reasonsAreVacuous(reasons: string): boolean {
  const trimmed = reasons.trim();
  return trimmed.length < 20 || VACUOUS.test(trimmed);
}

export class Inspectorate {
  private readonly seats = new Map<string, InspectorGeneral>();
  private readonly dossiers = new Map<string, Dossier>();
  /** §13.8 — a certificate is single-use. Spent serials are never reusable. */
  private readonly spent = new Set<string>();

  constructor(private readonly doc: ConstitutionDocument) {}

  /**
   * Seating is a human act. This accepts a PUBLIC key and has no way to
   * generate the private half — so calling it does not give the caller the
   * ability to produce a determination.
   */
  seat(inspector: InspectorGeneral): void {
    if (inspector.kind !== 'human') {
      throw new Error('Article XIII §13.5: an Inspector General is never an agent.');
    }
    if (!inspector.publicKey || inspector.publicKey.includes('MC4CAQAwBQYDK2Vw')) {
      // A PKCS8 preamble means somebody pasted a PRIVATE key into the seat
      // register — the same operator error the Orion registry validator
      // catches, and the same refusal.
      throw new Error('Article XIII §13.5: a seat holds a public key only.');
    }
    this.seats.set(inspector.id, inspector);
  }

  unseat(inspectorId: string): void {
    this.seats.delete(inspectorId);
  }

  get seated(): InspectorGeneral[] {
    return [...this.seats.values()];
  }

  /** §13.4 — below the minimum, the Inspectorate issues nothing. */
  get hasQuorum(): boolean {
    return this.seats.size >= this.doc.inspectorate.minimum_seated;
  }

  requiresUnanimity(risk: RiskClass): boolean {
    return this.doc.inspectorate.unanimity_required_for.includes(risk);
  }

  /** How many concurrences this candidate needs, given who is seated. */
  concurrencesRequired(risk: RiskClass): number {
    const seated = this.seats.size;
    if (this.requiresUnanimity(risk)) return seated;
    return Math.floor(seated / 2) + 1; // simple majority of those seated
  }

  /** §13.7 — opening a dossier starts the clock. §13.8 — expiry is refusal. */
  openDossier(candidate: ReleaseCandidate, now: number = Date.now()): Dossier {
    const dossier: Dossier = {
      candidateId: candidate.id,
      payloadDigest: candidate.payloadDigest,
      openedAt: now,
      expiresAt: now + this.doc.time_limits_ms.inspectorate_review_window,
      determinations: [],
      disposition: 'pending',
      seatedAtOpen: this.seats.size,
    };
    this.dossiers.set(candidate.id, dossier);
    return dossier;
  }

  /**
   * Record a signed determination.
   *
   * Refuses an unseated inspector, an invalid signature, a vacuous reason, and
   * — §13.9 — a reviewer who is also the proposer.
   */
  record(
    candidate: ReleaseCandidate,
    determination: Determination,
    now: number = Date.now(),
  ): { accepted: boolean; reason?: ReleaseRefusal; detail?: string } {
    const dossier = this.dossiers.get(candidate.id);
    if (!dossier) return { accepted: false, reason: 'candidate_mismatch', detail: 'no dossier is open' };
    if (now > dossier.expiresAt) {
      dossier.disposition = 'expired';
      return { accepted: false, reason: 'review_window_expired', detail: 'the window closed; expiry is refusal' };
    }

    const seat = this.seats.get(determination.inspectorId);
    if (!seat) return { accepted: false, reason: 'unseated_inspector', detail: determination.inspectorId };

    // §13.9 — a dossier in which a reviewer is also the proposer is void.
    if (determination.inspectorId === candidate.proposedBy) {
      dossier.disposition = 'refused';
      return { accepted: false, reason: 'conflict_of_interest', detail: 'the reviewer proposed this release' };
    }

    if (!verifyDetermination(determination, candidate, seat.publicKey)) {
      return { accepted: false, reason: 'signature_invalid', detail: determination.inspectorId };
    }
    if (determination.concurs && reasonsAreVacuous(determination.reasons)) {
      return { accepted: false, reason: 'insufficient_concurrence', detail: 'a vacuous rationale is not a determination' };
    }

    // One determination per inspector; a later one replaces an earlier one.
    dossier.determinations = dossier.determinations.filter((d) => d.inspectorId !== determination.inspectorId);
    dossier.determinations.push(determination);
    return { accepted: true };
  }

  /**
   * Issue a Certificate of Release, or refuse.
   *
   * Note what this does NOT do: it does not sign anything. The certificate's
   * authority comes entirely from the determinations already signed by people.
   * This method only counts them, and counting is all a machine is entitled to
   * do here.
   */
  certify(candidate: ReleaseCandidate, now: number = Date.now()): ReleaseOutcome {
    if (!this.hasQuorum) {
      return {
        released: false,
        reason: 'below_quorum',
        detail: `${this.seats.size} seated, ${this.doc.inspectorate.minimum_seated} required — the Inspectorate issues nothing`,
      };
    }

    const dossier = this.dossiers.get(candidate.id);
    if (!dossier) return { released: false, reason: 'no_certificate', detail: 'no review has taken place' };

    if (now > dossier.expiresAt) {
      dossier.disposition = 'expired';
      return { released: false, reason: 'review_window_expired', detail: 'silence is refusal, never deemed consent' };
    }
    if (dossier.payloadDigest !== candidate.payloadDigest) {
      return { released: false, reason: 'digest_mismatch', detail: 'the payload changed after review opened' };
    }

    const concurring = dossier.determinations.filter(
      (d) => d.concurs && verifyDetermination(d, candidate, this.seats.get(d.inspectorId)?.publicKey ?? ''),
    );

    // §13.10 — belt and braces. A concurrence from the proposer is discarded
    // even though `record` already refuses it.
    const eligible = concurring.filter((d) => d.inspectorId !== candidate.proposedBy);
    if (eligible.length !== concurring.length) {
      return { released: false, reason: 'self_certification', detail: 'the proposer cannot concur in their own release' };
    }

    const required = this.concurrencesRequired(candidate.risk);
    if (eligible.length < required) {
      dossier.disposition = 'refused';
      return {
        released: false,
        reason: 'insufficient_concurrence',
        detail: `${eligible.length} of ${required} required (${this.requiresUnanimity(candidate.risk) ? 'unanimity' : 'simple majority'} of ${this.seats.size} seated)`,
      };
    }

    // §13.11 / §13.12 — a clearance to one destination is never a clearance to
    // another. A destination not expressly cleared is refused.
    if (candidate.kind === 'cross_application_feed_share') {
      const destinations = candidate.destinations ?? [];
      if (destinations.length === 0) {
        return { released: false, reason: 'destination_not_cleared', detail: 'a feed share names no destination' };
      }
      const clearances = this.cityWorld.get(candidate.id) ?? {};
      const uncleared = destinations.filter((d) => clearances[d] !== true);
      if (uncleared.length > 0) {
        return {
          released: false,
          reason: 'destination_not_cleared',
          detail: `City World has not cleared: ${uncleared.join(', ')}`,
        };
      }
    }

    dossier.disposition = 'certified';
    return {
      released: true,
      certificate: {
        candidateId: candidate.id,
        payloadDigest: candidate.payloadDigest,
        issuedAt: now,
        expiresAt: now + this.doc.time_limits_ms.certificate_validity,
        concurringInspectors: eligible.map((d) => d.inspectorId),
        cityWorldClearances: this.cityWorld.get(candidate.id),
        serial: crypto.randomUUID(),
      },
    };
  }

  /**
   * §13.12 — City World's per-destination determination.
   *
   * Recorded here, decided elsewhere. Orion Prime's City World is the reviewer;
   * this system only refuses to proceed without its answer. A destination with
   * no recorded determination is refused, which is the same rule as §13.8.
   */
  private readonly cityWorld = new Map<string, Record<string, boolean>>();

  recordCityWorldClearance(candidateId: string, destination: string, cleared: boolean): void {
    if (!this.doc.city_world_destinations.includes(destination)) {
      throw new Error(`Article XIII §13.12: ${destination} is not a City World destination.`);
    }
    const existing = this.cityWorld.get(candidateId) ?? {};
    existing[destination] = cleared;
    this.cityWorld.set(candidateId, existing);
  }

  /**
   * Redeem a certificate at the moment of release. §13.8 — single use, and a
   * lapsed certificate is void.
   */
  redeem(certificate: CertificateOfRelease, candidate: ReleaseCandidate, now: number = Date.now()): ReleaseOutcome {
    if (this.spent.has(certificate.serial)) {
      return { released: false, reason: 'certificate_spent', detail: 'a Certificate of Release is single-use' };
    }
    if (now > certificate.expiresAt) {
      return { released: false, reason: 'certificate_expired', detail: 'a lapsed certificate is void' };
    }
    if (certificate.candidateId !== candidate.id) {
      return { released: false, reason: 'candidate_mismatch', detail: 'this certificate belongs to another release' };
    }
    if (certificate.payloadDigest !== candidate.payloadDigest) {
      return { released: false, reason: 'digest_mismatch', detail: 'the payload changed after certification' };
    }
    if (!this.hasQuorum) {
      return { released: false, reason: 'below_quorum', detail: 'the Inspectorate has fallen below quorum since issue' };
    }

    // Re-verify against the CURRENT seat register. An inspector unseated since
    // issue no longer counts, which is what makes removal meaningful.
    const dossier = this.dossiers.get(candidate.id);
    const stillValid = (dossier?.determinations ?? []).filter(
      (d) =>
        d.concurs &&
        certificate.concurringInspectors.includes(d.inspectorId) &&
        d.inspectorId !== candidate.proposedBy &&
        this.seats.has(d.inspectorId) &&
        verifyDetermination(d, candidate, this.seats.get(d.inspectorId)!.publicKey),
    );

    if (stillValid.length < this.concurrencesRequired(candidate.risk)) {
      return {
        released: false,
        reason: 'insufficient_concurrence',
        detail: 'concurrence no longer holds against the current seat register',
      };
    }

    this.spent.add(certificate.serial);
    return { released: true, certificate };
  }
}
