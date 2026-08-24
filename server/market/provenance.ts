/**
 * Financial provenance — every posting linked, in both directions.
 *
 * BALANCING IS NOT ENOUGH
 * -----------------------
 * `settlement.ts` guarantees each party's legs sum to zero. That makes the
 * arithmetic right and says nothing about whether the money is *accounted for*.
 * A balanced entry with no provenance is a number somebody can defend only by
 * saying "the system produced it", which is precisely the answer Article V
 * exists to forbid.
 *
 * So every posting carries the full chain of custody:
 *
 *     posting → settlement → trade → bid → offer → rationale
 *                    ↘ authorisation receipt (Article IV)
 *                    ↘ previous posting for this participant (Article III §3.4)
 *
 * Two directions, and both are asserted:
 *
 *   FORWARD  — from any posting you can name the trade, the counterparty, the
 *              price it cleared at, who authorised the spend, and why the offer
 *              existed at that price in the first place.
 *   BACKWARD — from a trade you can recover exactly the postings it produced,
 *              and their sums must reconcile to the trade's own stated gross
 *              and fee. If they do not, one of the two is lying and the
 *              reconciliation says which.
 *
 * That round trip is the property that makes a ledger auditable rather than
 * merely tidy.
 */

import crypto from 'crypto';
import { toDecimalString, type Minor } from '../constitution/money';
import type { Leg, ParticipantId, SettlementRecord, Trade } from './types';

/** The immutable links. Every one of these is required — there is no partial provenance. */
export interface Provenance {
  tradeId: string;
  offerId: string;
  bidId: string;
  settlementDigest: string;
  /** Article IV §4.5. The receipt that permitted the buyer's commitment. */
  authorisationSerial: string;
  /** Article V. The digest of the rationale, so the reason cannot be edited after the fact. */
  rationaleDigest: string;
  counterparty: ParticipantId;
}

/**
 * What a posting IS, stated rather than inferred.
 *
 * `reconcile` needs this: after a refund, the postings for a trade legitimately
 * no longer sum to the trade's gross, and a checker that cannot tell a
 * correction from an original would report a healthy ledger as broken. Sniffing
 * the memo for "REVERSAL" would work until somebody edits a memo.
 */
export type PostingKind = 'settlement' | 'correction' | 'release';

/** One line in one participant's book. Append-only; a correction is a new reversing posting. */
export interface Posting {
  id: string;
  kind: PostingKind;
  participant: ParticipantId;
  account: string;
  amount: Minor;
  memo: string;
  at: number;
  provenance: Provenance;
  /** Article III §3.4 — this participant's previous posting digest. */
  previousDigest: string;
  digest: string;
}

export const GENESIS = '0'.repeat(64);

export function digestRationale(summary: string, inputs: Record<string, unknown>, threshold: unknown): string {
  return crypto
    .createHash('sha256')
    .update([summary, JSON.stringify(inputs, Object.keys(inputs).sort()), JSON.stringify(threshold)].join('\n'))
    .digest('hex');
}

/**
 * The posting digest covers the links as well as the amount.
 *
 * Deliberate: if provenance were outside the hash, an entry's amount would be
 * tamper-evident while the trade it claims to belong to could be swapped
 * freely — which is a more useful attack than changing the number.
 */
export function postingDigest(p: Omit<Posting, 'digest'>): string {
  return crypto
    .createHash('sha256')
    .update([
      'v12-posting-1',
      p.id, p.kind, p.participant, p.account, p.amount.toString(), String(p.at),
      p.provenance.tradeId, p.provenance.offerId, p.provenance.bidId,
      p.provenance.settlementDigest, p.provenance.authorisationSerial,
      p.provenance.rationaleDigest, p.provenance.counterparty,
      p.previousDigest,
    ].join('\n'))
    .digest('hex');
}

export interface ChainHeads {
  /** Latest posting digest per participant. GENESIS if they have never posted. */
  get(participant: ParticipantId): string;
}

/**
 * Turn a settlement into linked postings, chained per participant.
 *
 * Chained PER PARTICIPANT, not globally: a global chain would mean one
 * company's posting order is observable from another's book, which leaks
 * activity volume across a tenancy boundary. Each company's chain is its own
 * and verifies independently.
 */
export function buildPostings(args: {
  record: SettlementRecord;
  trade: Trade;
  offerRationaleDigest: string;
  heads: ChainHeads;
  idFor: (index: number) => string;
}): Posting[] {
  const { record, trade } = args;
  if (!trade.authorisationSerial) {
    throw new Error('Article IV §4.1: postings cannot be built for a trade with no authorisation receipt.');
  }

  // Mutable per-participant heads as we chain within this settlement.
  const heads = new Map<string, string>();
  const headFor = (p: ParticipantId): string => heads.get(p) ?? args.heads.get(p);

  return record.legs.map((leg: Leg, index) => {
    const counterparty = leg.participant === trade.seller ? trade.buyer : trade.seller;
    const previousDigest = headFor(leg.participant);

    const unsigned: Omit<Posting, 'digest'> = {
      id: args.idFor(index),
      kind: 'settlement',
      participant: leg.participant,
      account: leg.account,
      amount: leg.amount,
      memo: leg.memo,
      at: record.at,
      provenance: {
        tradeId: trade.id,
        offerId: trade.offerId,
        bidId: trade.bidId,
        settlementDigest: record.digest,
        authorisationSerial: trade.authorisationSerial!,
        rationaleDigest: args.offerRationaleDigest,
        counterparty,
      },
      previousDigest,
    };

    const digest = postingDigest(unsigned);
    heads.set(leg.participant, digest);
    return { ...unsigned, digest };
  });
}

export type ReconciliationFailure =
  | { kind: 'unbalanced'; participant: ParticipantId; difference: string }
  | { kind: 'gross_mismatch'; expected: string; found: string }
  | { kind: 'fee_mismatch'; expected: string; found: string }
  | { kind: 'orphan_posting'; postingId: string; tradeId: string }
  | { kind: 'broken_chain'; postingId: string; participant: ParticipantId }
  | { kind: 'tampered'; postingId: string }
  | { kind: 'missing_link'; postingId: string; field: string };

export type Reconciliation = { ok: true } | { ok: false; failures: ReconciliationFailure[] };

/**
 * The backward direction: prove these postings ARE this trade.
 *
 * Every failure mode is reported, not just the first — unlike a refusal to a
 * caller, this is an operator-facing integrity report and a partial answer
 * during an investigation is worse than a slow one.
 */
export function reconcile(trade: Trade, allPostings: Posting[], heads: ChainHeads): Reconciliation {
  const failures: ReconciliationFailure[] = [];

  /*
   * Corrections and releases are checked for integrity like everything else,
   * but only SETTLEMENT postings are measured against the trade's own gross and
   * fee. A refunded trade's postings correctly no longer sum to its gross, and
   * conflating the two would report a healthy ledger as broken — the most
   * expensive kind of false alarm, because people stop believing the checker.
   */
  const postings = allPostings.filter((p) => p.kind === 'settlement');

  // ---- every posting belongs to this trade, and carries every link
  for (const p of allPostings) {
    if (p.provenance.tradeId !== trade.id) {
      failures.push({ kind: 'orphan_posting', postingId: p.id, tradeId: p.provenance.tradeId });
    }
    for (const field of ['offerId', 'bidId', 'settlementDigest', 'authorisationSerial', 'rationaleDigest', 'counterparty'] as const) {
      if (!p.provenance[field]) failures.push({ kind: 'missing_link', postingId: p.id, field });
    }
    const { digest, ...unsigned } = p;
    if (postingDigest(unsigned) !== digest) failures.push({ kind: 'tampered', postingId: p.id });
  }

  // ---- each participant balances, and their chain is intact
  for (const participant of [trade.seller, trade.buyer]) {
    const own = allPostings.filter((p) => p.participant === participant);
    const sum = own.reduce((acc, p) => acc + p.amount, 0n);
    if (sum !== 0n) {
      failures.push({ kind: 'unbalanced', participant, difference: toDecimalString(sum) });
    }

    let expectedPrevious = heads.get(participant);
    for (const p of own) {
      if (p.previousDigest !== expectedPrevious) {
        failures.push({ kind: 'broken_chain', postingId: p.id, participant });
      }
      expectedPrevious = p.digest;
    }
  }

  // ---- the trade's own numbers must be recoverable from the postings
  const buyerCash = postings
    .filter((p) => p.participant === trade.buyer && p.account === 'cash')
    .reduce((acc, p) => acc + p.amount, 0n);
  const fees = postings.filter((p) => p.account === 'fees').reduce((acc, p) => acc + p.amount, 0n);
  const buyerFee = postings
    .filter((p) => p.participant === trade.buyer && p.account === 'fees')
    .reduce((acc, p) => acc + p.amount, 0n);

  const grossFromPostings = -buyerCash - buyerFee;
  if (grossFromPostings !== trade.grossAmount) {
    failures.push({
      kind: 'gross_mismatch',
      expected: toDecimalString(trade.grossAmount),
      found: toDecimalString(grossFromPostings),
    });
  }
  if (fees !== trade.feeAmount) {
    failures.push({ kind: 'fee_mismatch', expected: toDecimalString(trade.feeAmount), found: toDecimalString(fees) });
  }

  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

/**
 * The forward direction: from one posting, state the whole story in plain
 * language. This is what an auditor, a counterparty or a court is handed.
 */
export function explain(posting: Posting, trade: Trade): string {
  const direction = posting.amount >= 0n ? 'debit' : 'credit';
  return [
    `${toDecimalString(posting.amount < 0n ? -posting.amount : posting.amount)} ${direction} to ${posting.account}`,
    `for ${posting.participant}, arising from trade ${posting.provenance.tradeId}`,
    `with ${posting.provenance.counterparty}:`,
    `${trade.quantity} ${trade.listing.unit} of ${trade.listing.sku}`,
    `at ${toDecimalString(trade.unitPrice)} per ${trade.listing.unit}.`,
    `Offer ${posting.provenance.offerId}, bid ${posting.provenance.bidId},`,
    `authorised by receipt ${posting.provenance.authorisationSerial}.`,
    `Settlement ${posting.provenance.settlementDigest.slice(0, 16)}…,`,
    `rationale ${posting.provenance.rationaleDigest.slice(0, 16)}….`,
  ].join(' ');
}

/** Article III §3.3 — a correction is a new linked reversing posting, never an edit. */
export function reverse(posting: Posting, reason: string, at: number, id: string, previousDigest: string): Posting {
  if (reason.trim().length < 10) {
    throw new Error('Article III §3.3: a reversal must state its cause.');
  }
  const unsigned: Omit<Posting, 'digest'> = {
    id,
    kind: 'correction',
    participant: posting.participant,
    account: posting.account,
    amount: -posting.amount,
    memo: `REVERSAL of ${posting.id}: ${reason}`,
    at,
    // The reversal inherits the original's provenance, so the pair remains
    // attached to the same trade rather than floating free.
    provenance: posting.provenance,
    previousDigest,
  };
  return { ...unsigned, digest: postingDigest(unsigned) };
}
