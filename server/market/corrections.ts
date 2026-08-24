/**
 * Committing a correction — the step that was missing.
 *
 * WHAT WAS WRONG
 * --------------
 * `disputes.ts` computes refund postings and escrow-release postings correctly,
 * with four legs, chained per participant, balancing on both books. And nothing
 * wrote them anywhere.
 *
 * A refund that exists as a correct calculation and never as a committed fact is
 * not a refund. The buyer has the same balance they had before, the seller still
 * holds the escrow, and the only trace of the Inspector General's decision is a
 * value that went out of scope. This file is that gap closed: postings in,
 * durable double-entry plus an audit trail out, atomically, exactly once.
 *
 * THREE PROPERTIES, AND EACH ONE MATTERS SEPARATELY
 * -------------------------------------------------
 *   ATOMIC — the legs and the audit entries commit in one transaction. A
 *   correction that exists without its audit entry is unexplainable; an audit
 *   entry claiming a correction that rolled back is worse, because it is a
 *   record of something that did not happen.
 *
 *   EXACTLY ONCE — enforced by the database, not by a flag this code checks.
 *   `UNIQUE (tenant_id, trade_id, kind)` means a retried request, a duplicated
 *   queue message and an impatient operator all land on the same row. Refunding
 *   a buyer twice is not a rounding error, and "we check first" is not a control
 *   when two requests can check simultaneously.
 *
 *   BALANCED BEFORE IT IS WRITTEN — every party's legs must sum to zero
 *   independently, checked here rather than trusted from upstream. `reconcile`
 *   already caught this once when refunds produced one leg per party; a checker
 *   that only runs after the write tells you your books are broken, which is
 *   later than you want to find out.
 *
 * WHO MAY DO THIS
 * ---------------
 * A refund requires a named human decider. Article X reserves dispute
 * resolution to a person, and the field is not optional: a correction with no
 * named decider is a correction nobody made. An escrow release is different —
 * it is the passage of time with no live dispute, so it names the rule rather
 * than a person.
 */

import crypto from 'crypto';
import { toDecimalString, type Minor } from '../constitution/money';
import type { CorrectionRecord } from '../store/types';
import type { NewAuditEntry } from '../store/types';
import type { Dispute } from './disputes';
import type { Posting } from './provenance';
import type { Leg, ParticipantId, Trade } from './types';

export type CorrectionRefusal =
  | 'nothing_to_commit'
  | 'unbalanced'
  | 'wrong_kind'
  | 'no_decider'
  | 'dispute_not_upheld'
  | 'already_committed';

export interface CorrectionProblem {
  reason: CorrectionRefusal;
  detail: string;
}

export type CorrectionOutcome<T> = { ok: true; value: T } | ({ ok: false } & CorrectionProblem);

const no = (reason: CorrectionRefusal, detail: string): CorrectionOutcome<never> => ({ ok: false, reason, detail });

/** Everything this needs from storage. Narrow, so it is testable without a database. */
export interface CorrectionPort {
  commit(correction: CorrectionRecord, entries: NewAuditEntry[]): Promise<'committed' | 'already_committed'>;
  now(): number;
  newId(prefix: string): string;
}

/** A posting is a chained ledger line; a leg is what the store persists. */
export function postingsToLegs(postings: Posting[]): Leg[] {
  return postings.map((p) => ({
    participant: p.participant,
    account: p.account,
    amount: p.amount,
    memo: p.memo,
  }));
}

/**
 * SHA-256 over the correction, so it can be linked into provenance and cannot
 * be edited afterwards without the link breaking.
 *
 * The chained posting digests are folded in, not just the amounts: two refunds
 * of the same value against the same trade would otherwise digest identically,
 * and the whole point of the chain is that position in it is part of identity.
 */
export function correctionDigest(tradeId: string, kind: CorrectionRecord['kind'], postings: Posting[]): string {
  const body = postings
    .map((p) => [p.id, p.participant, p.account, p.amount.toString(), p.previousDigest, p.digest].join('|'))
    .join('\n');
  return crypto.createHash('sha256').update(`v12-correction-1\n${tradeId}\n${kind}\n${body}`).digest('hex');
}

/**
 * Every party's legs must sum to zero independently.
 *
 * Not "the whole set sums to zero" — that would pass a refund that took money
 * out of the seller's book and put it into the buyer's without either book
 * balancing, which is exactly the shape of the bug this catches.
 */
export function eachSideBalances(legs: Leg[]): { ok: true } | { ok: false; participant: ParticipantId; net: Minor } {
  const totals = new Map<ParticipantId, Minor>();
  for (const leg of legs) totals.set(leg.participant, (totals.get(leg.participant) ?? 0n) + leg.amount);
  for (const [participant, net] of totals) {
    if (net !== 0n) return { ok: false, participant, net };
  }
  return { ok: true };
}

function validate(postings: Posting[], kind: CorrectionRecord['kind']): CorrectionOutcome<Leg[]> {
  if (postings.length === 0) {
    return no('nothing_to_commit', 'There are no postings to commit. A zero-value correction is not written at all.');
  }
  const wrongKind = postings.find((p) => (kind === 'refund' ? p.kind !== 'correction' : p.kind !== 'release'));
  if (wrongKind) {
    return no(
      'wrong_kind',
      `Posting ${wrongKind.id} is of kind "${wrongKind.kind}", which does not belong in a ${kind}. ` +
        'Reconciliation distinguishes originals from corrections by this field, so a mislabelled posting makes a ' +
        'healthy ledger read as broken.',
    );
  }

  const legs = postingsToLegs(postings);
  const balance = eachSideBalances(legs);
  if (!balance.ok) {
    return no(
      'unbalanced',
      `${balance.participant}'s legs net to ${toDecimalString(balance.net)} rather than zero. A correction is ` +
        'double entry on BOTH sides, like any other monetary event — money returning to the buyer is matched by ' +
        'the goods they did not receive.',
    );
  }
  return { ok: true, value: legs };
}

export interface CommittedCorrection {
  record: CorrectionRecord;
  status: 'committed' | 'already_committed';
}

/**
 * Commit an upheld dispute's refund.
 *
 * Refuses a dispute that is not upheld, because the postings would then be
 * arithmetic nobody authorised, and refuses an unnamed decider, because Article
 * X §10.3 puts a person at the end of this decision and a blank field is how
 * that requirement quietly becomes optional.
 */
export async function commitRefund(
  port: CorrectionPort,
  args: { dispute: Dispute; postings: Posting[] },
): Promise<CorrectionOutcome<CommittedCorrection>> {
  const { dispute } = args;
  if (dispute.status !== 'upheld' || !dispute.resolution?.upheld) {
    return no('dispute_not_upheld', `Dispute ${dispute.id} is ${dispute.status}. Only an upheld dispute refunds.`);
  }
  const decidedBy = dispute.resolution.resolvedBy?.name?.trim();
  if (!decidedBy) {
    return no(
      'no_decider',
      'The resolution names no decider. Dispute resolution belongs to a human, and an unnamed one is an unmade decision.',
    );
  }

  const validated = validate(args.postings, 'refund');
  if (!validated.ok) return validated;

  const record: CorrectionRecord = {
    id: port.newId('corr'),
    tradeId: dispute.tradeId,
    kind: 'refund',
    legs: validated.value,
    digest: correctionDigest(dispute.tradeId, 'refund', args.postings),
    reason: `Dispute ${dispute.id} upheld: ${dispute.resolution.reasons}`,
    decidedBy,
    createdAt: port.now(),
  };

  // Recorded for BOTH parties. A correction only one side can see in their own
  // record is not a correction the other can rely on.
  const entries: NewAuditEntry[] = [dispute.raisedBy, dispute.against].map((participant) => ({
    event: 'market.correction.refund',
    actorId: dispute.resolution!.resolvedBy.id,
    actorName: decidedBy,
    actorRole: 'Inspector General',
    subject: dispute.tradeId,
    outcome: 'allowed',
    detail: {
      disputeId: dispute.id,
      participant,
      refund: dispute.resolution!.refund.toString(),
      digest: record.digest,
    },
  }));

  const status = await port.commit(record, entries);
  return { ok: true, value: { record, status } };
}

/**
 * Commit an escrow release.
 *
 * No human decider, deliberately: this is the dispute window closing with
 * nothing raised, so the record names the rule that released the money rather
 * than pretending someone chose to.
 */
export async function commitRelease(
  port: CorrectionPort,
  args: { trade: Trade; postings: Posting[]; windowMs: number },
): Promise<CorrectionOutcome<CommittedCorrection>> {
  const validated = validate(args.postings, 'release');
  if (!validated.ok) return validated;

  const days = Math.round(args.windowMs / 86_400_000);
  const record: CorrectionRecord = {
    id: port.newId('corr'),
    tradeId: args.trade.id,
    kind: 'release',
    legs: validated.value,
    digest: correctionDigest(args.trade.id, 'release', args.postings),
    reason: `Dispute window of ${days} day(s) closed with no live dispute.`,
    decidedBy: 'rule: dispute window closed',
    createdAt: port.now(),
  };

  const entries: NewAuditEntry[] = [args.trade.seller, args.trade.buyer].map((participant) => ({
    event: 'market.escrow.released',
    actorId: null,
    actorName: 'system',
    actorRole: null,
    subject: args.trade.id,
    outcome: 'allowed',
    detail: { participant, digest: record.digest, windowDays: days },
  }));

  const status = await port.commit(record, entries);
  return { ok: true, value: { record, status } };
}

/** Plain language for the parties. A correction nobody can read is a correction nobody trusts. */
export function describeCorrection(record: CorrectionRecord): string {
  const moved = record.legs
    .filter((l) => l.amount > 0n)
    .map((l) => `${toDecimalString(l.amount)} to ${l.participant}'s ${l.account}`)
    .join(', ');
  return [
    record.kind === 'refund' ? 'Refund' : 'Escrow release',
    `on trade ${record.tradeId}: ${moved || 'no net movement'}.`,
    `Reason: ${record.reason}`,
    `Decided by: ${record.decidedBy}.`,
    `Digest ${record.digest.slice(0, 16)}….`,
  ].join(' ');
}
