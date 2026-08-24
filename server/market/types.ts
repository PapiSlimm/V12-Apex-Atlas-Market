/**
 * Cross-company trade — the structure that makes Apex a market rather than a
 * ledger with a nice interface.
 *
 * WHAT WAS MISSING
 * ----------------
 * Everything built before this could value inventory, enforce limits, refuse
 * bad instructions and keep an unfalsifiable record — for ONE company. A trade
 * between two companies has a property none of that addresses: it is two sets
 * of books that must agree, owned by parties who must not be able to read each
 * other's, settled so that either both move or neither does.
 *
 * THE MODEL
 * ---------
 * An Offer is a standing willingness to sell, posted by one participant. A Bid
 * is a specific proposal against it. Acceptance produces a Trade, and a Trade
 * settles exactly once into a SettlementRecord holding both parties' legs.
 *
 * Money is `Minor` — integer minor units — everywhere. Article III §3.1 is not
 * negotiable and a float cannot enter this file, because there is no type here
 * that admits one.
 */

import type { Minor } from '../constitution/money';
import type { Rationale } from '../constitution/types';

/** A participant is a company admitted to the Galaxy. Not a desk, not a user. */
export type ParticipantId = string & { readonly __participant: unique symbol };
export const participantId = (raw: string): ParticipantId => raw as ParticipantId;

export type OfferStatus = 'open' | 'partially_taken' | 'filled' | 'withdrawn' | 'expired';
export type TradeStatus = 'proposed' | 'authorised' | 'settled' | 'refused' | 'cancelled';

/** What is being traded. Goods, services and resources — never a financial instrument. */
export interface Listing {
  /** Stable identifier for the thing on offer. */
  sku: string;
  title: string;
  /** e.g. 'render-hours', 'storage-tb-month', 'footage-licence', 'studio-time'. */
  category: string;
  /** The unit quantity is measured in, stated so two parties cannot mean different things. */
  unit: string;
}

export interface Offer {
  id: string;
  seller: ParticipantId;
  listing: Listing;
  /** Price per unit, minor units. */
  unitPrice: Minor;
  quantityAvailable: number;
  /** Below this, the seller will not break the lot. */
  minimumQuantity: number;
  status: OfferStatus;
  postedAt: number;
  expiresAt: number | null;
  /** Article V — why this is being offered at this price. Recorded before it is visible. */
  rationale: Rationale;
}

export interface Bid {
  id: string;
  offerId: string;
  buyer: ParticipantId;
  quantity: number;
  /** What the buyer will pay per unit. May exceed or undercut the offer. */
  unitPrice: Minor;
  placedAt: number;
  expiresAt: number;
  rationale: Rationale;
}

/**
 * One side's view of the money. Positive is a debit, negative a credit, and
 * EACH PARTY'S LEGS MUST SUM TO ZERO INDEPENDENTLY — a trade is not one balanced
 * transaction, it is two.
 */
export interface Leg {
  participant: ParticipantId;
  account: string;
  amount: Minor;
  memo: string;
}

export interface Trade {
  id: string;
  offerId: string;
  bidId: string;
  seller: ParticipantId;
  buyer: ParticipantId;
  listing: Listing;
  quantity: number;
  /** The price the trade actually cleared at. */
  unitPrice: Minor;
  grossAmount: Minor;
  /** The market's fee, split per `feeSplit`. */
  feeAmount: Minor;
  status: TradeStatus;
  /** Article IV §4.5 — the buyer's authorisation receipt serial. Required to settle. */
  authorisationSerial: string | null;
  proposedAt: number;
  settledAt: number | null;
}

export interface SettlementRecord {
  tradeId: string;
  at: number;
  /** Both parties' legs. Reading is filtered by participant — see `legsFor`. */
  legs: Leg[];
  /** SHA-256 over the settlement, linked into both parties' audit chains. */
  digest: string;
}

/**
 * Article II §2.1 in the trade layer.
 *
 * A settlement record physically contains both parties' legs, because that is
 * what makes it one atomic fact. Reading it is always filtered: a participant
 * sees their own legs and the trade's public terms, never the counterparty's
 * internal accounts. Passing the raw record to an API response is the mistake
 * this function exists to prevent.
 */
export function legsFor(record: SettlementRecord, participant: ParticipantId): Leg[] {
  return record.legs.filter((l) => l.participant === participant);
}

/** The market's cut, in basis points, and who bears it. */
export interface FeeSchedule {
  basisPoints: number;
  /** 'buyer', 'seller', or 'split' — half each, with any odd minor unit to the buyer. */
  bearer: 'buyer' | 'seller' | 'split';
}

export const DEFAULT_FEES: FeeSchedule = { basisPoints: 100, bearer: 'split' };
