/**
 * Disputes — what happens when one side says the goods never arrived.
 *
 * WHY THIS EXISTS AND WHY IT NEEDED ESCROW FIRST
 * ----------------------------------------------
 * A market that can settle but cannot handle a disagreement is a market people
 * use once. And a dispute process is theatre if the money has already left: by
 * the time a buyer discovers the render hours were never delivered, an unheld
 * settlement is somebody else's problem to claw back. So seller proceeds land
 * in `cash_held` at settlement, and reach `cash` only when the window closes
 * without a claim.
 *
 * THE FIVE RULES
 * --------------
 *  1. Only a PARTY to the trade may raise a dispute. Not the market, not
 *     another participant, not an observer.
 *  2. There is a WINDOW. After it closes the settlement is final, because
 *     certainty is worth as much to a market as recourse is.
 *  3. Grounds are REQUIRED, and vacuous grounds are not grounds — the same
 *     standard Article V applies to any consequential action.
 *  4. The counterparty is HEARD before a decision. A determination against
 *     someone who was never asked is not a determination.
 *  5. No agent resolves a dispute. Resolution moves money against a party's
 *     wishes, which is the most consequential act in this system, and it
 *     belongs to a human under Article X §10.1.
 *
 * Rule 5 is enforced the same way the Inspectorate is: the resolver identity is
 * a required field with a human kind, and there is no code path that supplies
 * one. An agent calling `resolve` must invent a person, and the audit record is
 * what catches that.
 */

import { toDecimalString, type Minor } from '../constitution/money';
import { postingDigest, reverse, type Posting } from './provenance';
import type { ParticipantId, Trade } from './types';

/** Schedule C style. A window long enough to notice, short enough to settle. */
export const DEFAULT_DISPUTE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type DisputeStatus = 'raised' | 'answered' | 'upheld' | 'rejected' | 'withdrawn';

export type DisputeGround =
  | 'not_delivered'
  | 'partially_delivered'
  | 'not_as_described'
  | 'duplicate_charge'
  | 'unauthorised';

export interface Dispute {
  id: string;
  tradeId: string;
  /** The party raising it. Must be the buyer or the seller. */
  raisedBy: ParticipantId;
  against: ParticipantId;
  ground: DisputeGround;
  /** Article V standard. What is claimed, with specifics. */
  statement: string;
  /** How much is in question. Never more than the trade's gross. */
  amountDisputed: Minor;
  raisedAt: number;
  /** The counterparty's answer, once given. */
  response: { statement: string; at: number } | null;
  status: DisputeStatus;
  resolution: Resolution | null;
}

export interface Resolution {
  /** A HUMAN. Article X §10.1 — no agent resolves a dispute. */
  resolvedBy: { id: string; name: string; kind: 'human' };
  upheld: boolean;
  /** How much is returned to the buyer. Zero when rejected. */
  refund: Minor;
  reasons: string;
  at: number;
}

export type DisputeRefusal =
  | 'not_a_party'
  | 'window_closed'
  | 'trade_not_settled'
  | 'grounds_vacuous'
  | 'amount_exceeds_trade'
  | 'amount_invalid'
  | 'already_disputed'
  | 'not_answered'
  | 'already_resolved'
  | 'resolver_not_human'
  | 'reasons_vacuous'
  | 'refund_exceeds_disputed'
  | 'escrow_still_held'
  | 'window_open';

export type DisputeOutcome<T> = { ok: true; value: T } | { ok: false; reason: DisputeRefusal; detail: string };

const no = (reason: DisputeRefusal, detail: string): DisputeOutcome<never> => ({ ok: false, reason, detail });

/** Rule 3. The same bar the Constitution sets for any consequential statement. */
function statementIsVacuous(statement: string): boolean {
  const text = (statement ?? '').trim();
  if (text.length < 40) return true;
  return /^(it('s| is) wrong|bad|didn'?t work|no good|scam|refund me)\.?$/i.test(text);
}

export function raiseDispute(args: {
  id: string;
  trade: Trade;
  raisedBy: ParticipantId;
  ground: DisputeGround;
  statement: string;
  amountDisputed: Minor;
  now: number;
  windowMs?: number;
  existing?: Dispute | null;
}): DisputeOutcome<Dispute> {
  const { trade, raisedBy, now } = args;

  // Rule 1 — a party, and only a party.
  if (raisedBy !== trade.buyer && raisedBy !== trade.seller) {
    return no('not_a_party', `${raisedBy} is not a party to ${trade.id}. Only the buyer or the seller may dispute it.`);
  }
  if (trade.status !== 'settled' || trade.settledAt === null) {
    return no('trade_not_settled', 'A trade that has not settled has nothing to dispute; cancel it instead.');
  }
  if (args.existing && args.existing.status !== 'withdrawn' && args.existing.status !== 'rejected') {
    return no('already_disputed', `${trade.id} already has an open dispute (${args.existing.id}).`);
  }

  // Rule 2 — the window.
  const windowMs = args.windowMs ?? DEFAULT_DISPUTE_WINDOW_MS;
  if (now > trade.settledAt + windowMs) {
    return no(
      'window_closed',
      `The ${Math.round(windowMs / 86_400_000)}-day dispute window closed. The settlement is final — certainty is ` +
        'worth as much to a market as recourse is.',
    );
  }

  // Rule 3 — grounds.
  if (statementIsVacuous(args.statement)) {
    return no('grounds_vacuous', 'A dispute must state specifically what is claimed. "It did not work" is not grounds.');
  }
  if (args.amountDisputed <= 0n) {
    return no('amount_invalid', 'The disputed amount must be positive.');
  }
  if (args.amountDisputed > trade.grossAmount) {
    return no(
      'amount_exceeds_trade',
      `${toDecimalString(args.amountDisputed)} exceeds the trade's gross of ${toDecimalString(trade.grossAmount)}.`,
    );
  }

  return {
    ok: true,
    value: {
      id: args.id,
      tradeId: trade.id,
      raisedBy,
      against: raisedBy === trade.buyer ? trade.seller : trade.buyer,
      ground: args.ground,
      statement: args.statement.trim(),
      amountDisputed: args.amountDisputed,
      raisedAt: now,
      response: null,
      status: 'raised',
      resolution: null,
    },
  };
}

/** Rule 4. The counterparty answers before anyone decides. */
export function respond(dispute: Dispute, responder: ParticipantId, statement: string, now: number): DisputeOutcome<Dispute> {
  if (responder !== dispute.against) {
    return no('not_a_party', 'Only the party a dispute is against may answer it.');
  }
  if (dispute.status !== 'raised') {
    return no('already_resolved', `The dispute is ${dispute.status}.`);
  }
  if (statementIsVacuous(statement)) {
    return no('grounds_vacuous', 'A response must engage with what is claimed.');
  }
  return { ok: true, value: { ...dispute, response: { statement: statement.trim(), at: now }, status: 'answered' } };
}

/**
 * Rule 5. A human decides, and the decision moves money.
 *
 * `answered` is required, not merely preferred: deciding against a party who
 * has not been heard is the failure this rule exists to prevent. If a
 * counterparty simply never answers, that is a business rule for a timeout
 * elsewhere — it must not silently become "decide anyway".
 */
export function resolve(args: {
  dispute: Dispute;
  resolvedBy: { id: string; name: string; kind: 'human' };
  upheld: boolean;
  refund: Minor;
  reasons: string;
  now: number;
}): DisputeOutcome<Dispute> {
  const { dispute } = args;

  if (dispute.status === 'upheld' || dispute.status === 'rejected') {
    return no('already_resolved', 'This dispute has already been resolved.');
  }
  if (dispute.status !== 'answered') {
    return no('not_answered', 'The counterparty has not been heard. A determination against an unheard party is not one.');
  }
  if (args.resolvedBy?.kind !== 'human' || !args.resolvedBy.id.trim() || !args.resolvedBy.name.trim()) {
    return no(
      'resolver_not_human',
      'Article X §10.1: a dispute resolution moves money against a party\'s wishes and is a human act. ' +
        'No agent may resolve a dispute.',
    );
  }
  if ((args.reasons ?? '').trim().length < 40) {
    return no('reasons_vacuous', 'A resolution must give reasons a losing party can read and understand.');
  }
  if (args.refund < 0n) return no('amount_invalid', 'A refund cannot be negative.');
  if (args.refund > dispute.amountDisputed) {
    return no('refund_exceeds_disputed', 'A resolution cannot award more than was disputed.');
  }
  if (!args.upheld && args.refund !== 0n) {
    return no('amount_invalid', 'A rejected dispute refunds nothing.');
  }

  return {
    ok: true,
    value: {
      ...dispute,
      status: args.upheld ? 'upheld' : 'rejected',
      resolution: {
        resolvedBy: args.resolvedBy,
        upheld: args.upheld,
        refund: args.refund,
        reasons: args.reasons.trim(),
        at: args.now,
      },
    },
  };
}

/**
 * Turn an upheld dispute into linked reversing postings.
 *
 * Article III §3.3 — the original postings stay. This appends the correction,
 * carrying the same provenance so the pair remains attached to its trade rather
 * than floating free as an unexplained credit.
 */
export function refundPostings(args: {
  dispute: Dispute;
  sellerHeldPosting: Posting;
  sellerInventoryPosting: Posting;
  buyerCashPosting: Posting;
  buyerInventoryPosting: Posting;
  heads: { get(p: ParticipantId): string };
  idFor: (suffix: string) => string;
  now: number;
}): Posting[] {
  const { dispute } = args;
  if (dispute.status !== 'upheld' || !dispute.resolution?.upheld) {
    throw new Error('Only an upheld dispute produces a refund.');
  }
  const refund = dispute.resolution.refund;
  if (refund === 0n) return [];

  const reason = `Dispute ${dispute.id} upheld by ${dispute.resolution.resolvedBy.name}: ${dispute.resolution.reasons}`;

  /*
   * FOUR legs, not two.
   *
   * My first version wrote one leg per party — held cash out of the seller,
   * cash back to the buyer — and `reconcile` immediately reported both books
   * unbalanced, which was correct. A refund is double entry on BOTH sides like
   * any other monetary event: money returning to the buyer is matched by the
   * goods they did not receive, and the seller's released escrow is matched by
   * the inventory they keep.
   *
   * A PARTIAL award is the normal case, so these are scaled copies rather than
   * whole-leg reversals — reversing the entire leg on a partial award would
   * hand back money nobody disputed.
   */
  const scale = (posting: Posting, amount: Minor): Posting => ({ ...posting, amount });

  // Each party chains onto its OWN head, so the two books stay independent.
  let sellerHead = args.heads.get(args.sellerHeldPosting.participant);
  let buyerHead = args.heads.get(args.buyerCashPosting.participant);

  const sellerCash = reverse(scale(args.sellerHeldPosting, refund), reason, args.now, args.idFor('seller-cash'), sellerHead);
  sellerHead = sellerCash.digest;
  const sellerInventory = reverse(scale(args.sellerInventoryPosting, -refund), reason, args.now, args.idFor('seller-inventory'), sellerHead);

  const buyerCash = reverse(scale(args.buyerCashPosting, -refund), reason, args.now, args.idFor('buyer-cash'), buyerHead);
  buyerHead = buyerCash.digest;
  const buyerInventory = reverse(scale(args.buyerInventoryPosting, refund), reason, args.now, args.idFor('buyer-inventory'), buyerHead);

  return [sellerCash, sellerInventory, buyerCash, buyerInventory];
}

/**
 * Release held funds once the window closes with no live dispute.
 *
 * Refuses while a dispute is open, and refuses before the window closes. Both
 * are the same principle: escrow that can be released early is not escrow.
 */
export function releaseEscrow(args: {
  trade: Trade;
  heldPosting: Posting;
  dispute: Dispute | null;
  now: number;
  windowMs?: number;
  idFor: (suffix: string) => string;
  heads: { get(p: ParticipantId): string };
}): DisputeOutcome<Posting[]> {
  const { trade, dispute, now } = args;
  const windowMs = args.windowMs ?? DEFAULT_DISPUTE_WINDOW_MS;

  if (trade.status !== 'settled' || trade.settledAt === null) {
    return no('trade_not_settled', 'Nothing is held for an unsettled trade.');
  }
  if (dispute && (dispute.status === 'raised' || dispute.status === 'answered')) {
    return no('escrow_still_held', `Dispute ${dispute.id} is open. Funds stay held until it is resolved.`);
  }
  if (now <= trade.settledAt + windowMs) {
    return no('window_open', 'The dispute window has not closed. Escrow that can be released early is not escrow.');
  }

  const head = args.heads.get(args.heldPosting.participant);
  const amount = args.heldPosting.amount;

  // Two legs, balancing on their own: held decreases, free cash increases.
  // Both legs are properly digested and chained — the second onto the first.
  // An earlier draft left `digest: ''` here, which would have written two
  // unverifiable postings into an otherwise tamper-evident book.
  const outHeldUnsigned = {
    ...args.heldPosting,
    kind: 'release' as const,
    id: args.idFor('release-held'),
    account: 'cash_held',
    amount: -amount,
    memo: `Escrow released, ${trade.id}`,
    at: now,
    previousDigest: head,
  };
  const { digest: _dropHeld, ...heldBase } = outHeldUnsigned as Posting & { digest?: string };
  const outHeld: Posting = { ...heldBase, digest: postingDigest(heldBase) } as Posting;

  const intoCashUnsigned = {
    ...args.heldPosting,
    kind: 'release' as const,
    id: args.idFor('release-cash'),
    account: 'cash',
    amount,
    memo: `Escrow released, ${trade.id}`,
    at: now,
    previousDigest: outHeld.digest,
  };
  const { digest: _dropCash, ...cashBase } = intoCashUnsigned as Posting & { digest?: string };
  const intoCash: Posting = { ...cashBase, digest: postingDigest(cashBase) } as Posting;

  return { ok: true, value: [outHeld, intoCash] };
}
