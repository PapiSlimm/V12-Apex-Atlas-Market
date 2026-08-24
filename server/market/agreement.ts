/**
 * Mutual agreement — the buyer and the seller decide, and the owner delivers.
 *
 * THE RULE THIS FILE EXISTS FOR
 * -----------------------------
 * A sale is agreed by both sides. Agents search, price, propose and negotiate;
 * they bind their company only inside a mandate a principal granted in advance
 * (mandate.ts). Delivery is the obligation of whoever owns the goods or
 * services — never of the market.
 *
 * WHAT WAS WRONG BEFORE THIS
 * --------------------------
 * `acceptBid` bound a trade one-sidedly: a seller posted an offer, a buyer bid
 * against it, and the engine matched them. The seller never agreed to that
 * particular buyer. Between companies that is most of the decision — a firm may
 * be perfectly happy with the price and entirely unwilling to sell to a
 * competitor, a sanctioned-adjacent party, or someone who owes them money.
 *
 * So a matched bid now produces a PROPOSAL, and a proposal becomes a trade only
 * when both principals have signed it.
 *
 * WHY THIS ALSO ANSWERS "WHY TRUST V12'S MARKET"
 * ----------------------------------------------
 * Because the market does not decide anything. It cannot force a sale, cannot
 * pick a counterparty, and cannot set a price. Its only real power is over who
 * it admits. That is a much smaller thing to have to trust, and it is checkable
 * from outside: every trade carries two signatures that Apex could not have
 * produced.
 */

import crypto from 'crypto';
import type { Minor } from '../constitution/money';
import { toDecimalString } from '../constitution/money';
import type { ParticipantId, Trade } from './types';

/**
 * Who is acting.
 *
 * `principal` is a human, or an office held by a human, empowered to bind the
 * company. `agent` is software. The distinction is not cosmetic: it is checked
 * before anything binds, and it is enforced the same way the Inspectorate and
 * dispute resolution are — by a signature the software cannot produce.
 */
export type ActorKind = 'principal' | 'agent';

export interface Actor {
  id: string;
  name: string;
  kind: ActorKind;
  /** The company this actor acts for. */
  participant: ParticipantId;
}

/** What a principal signs. Both sides sign the SAME terms, byte for byte. */
export interface Terms {
  proposalId: string;
  seller: ParticipantId;
  buyer: ParticipantId;
  sku: string;
  quantity: number;
  unitPrice: Minor;
  grossAmount: Minor;
  feeAmount: Minor;
  /** When the goods or services are to be delivered by. The owner's obligation. */
  deliverBy: number;
}

export interface Signature {
  actor: Actor;
  at: number;
  /** Ed25519 over the canonical terms, by a key the market does not hold. */
  signature: string;
  /** What the signer was shown. Guards against signing different terms. */
  termsDigest: string;
}

export type ProposalStatus = 'open' | 'agreed' | 'declined' | 'expired' | 'withdrawn';

export interface Proposal {
  id: string;
  offerId: string;
  bidId: string;
  terms: Terms;
  sellerSignature: Signature | null;
  buyerSignature: Signature | null;
  status: ProposalStatus;
  createdAt: number;
  expiresAt: number;
  declinedReason: string | null;
}

export type AgreementRefusal =
  | 'not_a_party'
  | 'agent_cannot_bind'
  | 'wrong_terms'
  | 'already_signed'
  | 'proposal_expired'
  | 'proposal_not_open'
  | 'signature_invalid'
  | 'reason_required';

export type AgreementOutcome<T> = { ok: true; value: T } | { ok: false; reason: AgreementRefusal; detail: string };

const no = (reason: AgreementRefusal, detail: string): AgreementOutcome<never> => ({ ok: false, reason, detail });

/** The exact bytes both principals sign. Ordered, unambiguous, no floats. */
export function termsCanonical(terms: Terms): string {
  return [
    'v12-terms-1',
    terms.proposalId,
    terms.seller,
    terms.buyer,
    terms.sku,
    String(terms.quantity),
    terms.unitPrice.toString(),
    terms.grossAmount.toString(),
    terms.feeAmount.toString(),
    String(terms.deliverBy),
  ].join('\n');
}

export function termsDigest(terms: Terms): string {
  return crypto.createHash('sha256').update(termsCanonical(terms)).digest('hex');
}

export function verifySignature(terms: Terms, signature: Signature, publicKey: string): boolean {
  try {
    return crypto.verify(
      null,
      Buffer.from(termsCanonical(terms), 'utf8'),
      crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }),
      Buffer.from(signature.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * Sign a proposal on behalf of one side.
 *
 * The four refusals here are the whole rule:
 *   - an actor who is not a party cannot sign
 *   - an agent cannot sign without a covering mandate
 *   - a signature over different terms than the proposal carries is refused
 *   - a side signs once
 */
export function sign(args: {
  proposal: Proposal;
  signature: Signature;
  publicKeyFor: (actor: Actor) => string | null;
  now: number;
  /**
   * Result of `checkMandate` when the signer is an agent. Undefined or false
   * means no covering mandate, and an agent is refused. Ignored for principals,
   * who need no delegation to act for themselves.
   */
  mandateSatisfied?: boolean;
}): AgreementOutcome<Proposal> {
  const { proposal, signature, now } = args;
  const actor = signature.actor;

  if (proposal.status !== 'open') {
    return no('proposal_not_open', `The proposal is ${proposal.status}.`);
  }
  if (now > proposal.expiresAt) {
    return no('proposal_expired', 'The proposal has expired. Terms nobody signed in time are not terms.');
  }
  if (actor.participant !== proposal.terms.seller && actor.participant !== proposal.terms.buyer) {
    return no('not_a_party', `${actor.participant} is not a party to this proposal.`);
  }

  /*
   * THE RULE, in its corrected form.
   *
   * A principal always may. An agent may ONLY when the caller has already
   * checked a live mandate covering these exact terms and passes
   * `mandateSatisfied`. The check itself lives in mandate.ts; this function
   * refuses to take the agent's word for it, and refuses to make the decision
   * itself, because a signing rule that can be satisfied by the thing being
   * governed is not a rule.
   *
   * The first version of this refused all agents outright. That was safe and
   * wrong: it put a human signature in front of every $400 trade, which is
   * exactly the cost that stopped those trades happening without a market.
   */
  if (actor.kind !== 'principal' && !args.mandateSatisfied) {
    return no(
      'agent_cannot_bind',
      `${actor.name} is an agent with no mandate covering these terms. Agents find products to buy, trade and ` +
        'sell; binding the company requires either a principal or a mandate a principal granted in advance.',
    );
  }

  const expected = termsDigest(proposal.terms);
  if (signature.termsDigest !== expected) {
    return no(
      'wrong_terms',
      'The signer was shown different terms than this proposal carries. A signature over terms the signer never ' +
        'saw is worse than no signature.',
    );
  }

  const isSeller = actor.participant === proposal.terms.seller;
  if (isSeller && proposal.sellerSignature) return no('already_signed', 'The seller has already signed.');
  if (!isSeller && proposal.buyerSignature) return no('already_signed', 'The buyer has already signed.');

  const publicKey = args.publicKeyFor(actor);
  if (!publicKey || !verifySignature(proposal.terms, signature, publicKey)) {
    return no('signature_invalid', 'The signature does not verify against this principal\'s registered key.');
  }

  const updated: Proposal = {
    ...proposal,
    sellerSignature: isSeller ? signature : proposal.sellerSignature,
    buyerSignature: isSeller ? proposal.buyerSignature : signature,
  };

  return {
    ok: true,
    value: { ...updated, status: bothSigned(updated) ? 'agreed' : 'open' },
  };
}

export function bothSigned(proposal: Proposal): boolean {
  return proposal.sellerSignature !== null && proposal.buyerSignature !== null;
}

/**
 * Either side may decline, and must say why.
 *
 * A seller declining a buyer they are happy to price but unwilling to deal with
 * is a legitimate and important act — it is the whole reason counterparty
 * choice belongs to the parties. The reason is recorded so a pattern of
 * declines is visible to whoever governs the market.
 */
export function decline(proposal: Proposal, actor: Actor, reason: string): AgreementOutcome<Proposal> {
  if (proposal.status !== 'open') return no('proposal_not_open', `The proposal is ${proposal.status}.`);
  if (actor.participant !== proposal.terms.seller && actor.participant !== proposal.terms.buyer) {
    return no('not_a_party', `${actor.participant} is not a party to this proposal.`);
  }
  if (actor.kind !== 'principal') {
    return no('agent_cannot_bind', 'Declining a sale is a decision, and decisions belong to principals.');
  }
  if ((reason ?? '').trim().length < 10) {
    return no('reason_required', 'A decline must state a reason. A silent refusal teaches the other side nothing.');
  }
  return { ok: true, value: { ...proposal, status: 'declined', declinedReason: reason.trim() } };
}

/**
 * Delivery is the OWNER'S obligation, not the market's.
 *
 * Apex records that a sale was agreed and holds the consideration. It does not
 * ship, render, license or perform anything. So delivery is asserted by the
 * seller and confirmed by the buyer, and it is the buyer's confirmation — not
 * the seller's assertion — that starts the clock towards release of escrow.
 * A seller who could confirm their own delivery would be marking their own
 * homework with the buyer's money.
 */
export interface Delivery {
  tradeId: string;
  assertedBySeller: { at: number; note: string } | null;
  confirmedByBuyer: { at: number; note: string } | null;
}

export type DeliveryRefusal = 'not_a_party' | 'agent_cannot_bind' | 'already_asserted' | 'already_confirmed' | 'not_asserted';

export function assertDelivered(args: {
  delivery: Delivery;
  trade: Trade;
  actor: Actor;
  note: string;
  now: number;
}): { ok: true; value: Delivery } | { ok: false; reason: DeliveryRefusal; detail: string } {
  if (args.actor.participant !== args.trade.seller) {
    return { ok: false, reason: 'not_a_party', detail: 'Only the seller asserts delivery.' };
  }
  if (args.actor.kind !== 'principal') {
    return { ok: false, reason: 'agent_cannot_bind', detail: 'Asserting delivery is a representation. It binds; an agent cannot make it.' };
  }
  if (args.delivery.assertedBySeller) {
    return { ok: false, reason: 'already_asserted', detail: 'Delivery has already been asserted.' };
  }
  return { ok: true, value: { ...args.delivery, assertedBySeller: { at: args.now, note: args.note } } };
}

export function confirmReceipt(args: {
  delivery: Delivery;
  trade: Trade;
  actor: Actor;
  note: string;
  now: number;
}): { ok: true; value: Delivery } | { ok: false; reason: DeliveryRefusal; detail: string } {
  if (args.actor.participant !== args.trade.buyer) {
    return { ok: false, reason: 'not_a_party', detail: 'Only the buyer confirms receipt.' };
  }
  if (args.actor.kind !== 'principal') {
    return { ok: false, reason: 'agent_cannot_bind', detail: 'Confirming receipt releases another company\'s money. It belongs to a principal.' };
  }
  if (!args.delivery.assertedBySeller) {
    return { ok: false, reason: 'not_asserted', detail: 'The seller has not asserted delivery yet.' };
  }
  if (args.delivery.confirmedByBuyer) {
    return { ok: false, reason: 'already_confirmed', detail: 'Receipt has already been confirmed.' };
  }
  return { ok: true, value: { ...args.delivery, confirmedByBuyer: { at: args.now, note: args.note } } };
}

/** A human-readable statement of who agreed to what. This is the contract. */
export function describeAgreement(proposal: Proposal): string {
  if (!bothSigned(proposal)) return `Proposal ${proposal.id} is not yet agreed.`;
  const t = proposal.terms;
  return [
    `${t.buyer} agreed to buy ${t.quantity} × ${t.sku} from ${t.seller}`,
    `at ${toDecimalString(t.unitPrice)} each, ${toDecimalString(t.grossAmount)} gross`,
    `plus ${toDecimalString(t.feeAmount)} market fee.`,
    `Signed by ${proposal.sellerSignature!.actor.name} for the seller`,
    `and ${proposal.buyerSignature!.actor.name} for the buyer.`,
    `Delivery is the seller's obligation.`,
  ].join(' ');
}
