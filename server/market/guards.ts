/**
 * The guardrails, in one file, deliberately.
 *
 * WHY THEY LIVE TOGETHER
 * ----------------------
 * Scattering checks through a lifecycle means nobody can answer "what stops X"
 * without reading everything. Here the complete set of things that can refuse a
 * trade is one list, each with its citation, and adding a control means adding
 * a case to a union that every call site must then handle.
 *
 * Every guard is a pure function returning a reason or null. None of them
 * throw, because a refusal is an outcome to record, not an exception to catch —
 * and a guard that throws is a guard someone will eventually wrap in a
 * try/catch that swallows it.
 *
 * ORDER MATTERS AND IS FIXED
 * --------------------------
 * Halt first (Article X §10.2 — before the next action), then standing
 * sanctions, then admission, then the trade's own facts. A halted estate must
 * not be able to learn whether its bid would otherwise have been valid.
 */

import type { Minor } from '../constitution/money';
import type { Rationale } from '../constitution/types';
import type { Offer, ParticipantId } from './types';

export type GuardCode =
  // ---- estate-level, checked before anything about the trade
  | 'ecosystem_halted'
  | 'participant_sanctioned'
  | 'participant_not_admitted'
  | 'counterparty_not_admitted'
  // ---- Article V
  | 'rationale_missing'
  | 'rationale_vacuous'
  // ---- the offer
  | 'offer_not_open'
  | 'offer_expired'
  | 'quantity_below_minimum'
  | 'quantity_exceeds_available'
  | 'quantity_invalid'
  // ---- inventory (Article III §3.2) — see inventory.ts
  | 'inventory_unaccounted'
  | 'inventory_insufficient'
  // ---- the bid
  | 'bid_expired'
  | 'price_invalid'
  | 'price_implausible'
  | 'self_dealing'
  // ---- limits
  | 'exceeds_order_ceiling'
  | 'exceeds_daily_exposure'
  | 'below_margin_floor'
  // ---- Article IV
  | 'no_authorisation'
  | 'authorisation_wrong_party'
  | 'authorisation_exceeded'
  | 'authorisation_expired';

export interface Refusal {
  code: GuardCode;
  citation: string;
  /** Plain language, for the participant who was refused. */
  detail: string;
}

const no = (code: GuardCode, citation: string, detail: string): Refusal => ({ code, citation, detail });

export interface EstateState {
  halted: boolean;
  sanctionedParticipants: ReadonlySet<string>;
  admittedParticipants: ReadonlySet<string>;
}

export interface ParticipantLimits {
  /** Largest single trade this participant may commit to. */
  maxOrderNotional: Minor;
  /** Rolling 24h ceiling. */
  maxDailyNotional: Minor;
  /** Already committed in the window. */
  committedToday: Minor;
  /** Minimum gross margin in basis points, for a seller. */
  marginFloorBasisPoints: number;
}

/**
 * Article V. A rationale that names nothing is not a rationale, and in a market
 * it is also the only thing a counterparty or an auditor can read afterwards to
 * understand why a price was what it was.
 */
export function checkRationale(rationale: Rationale | undefined): Refusal | null {
  if (!rationale) return no('rationale_missing', 'Article V §5.1', 'An action with no recorded rationale is not performed.');
  const summary = (rationale.summary ?? '').trim();
  if (summary.length < 40) {
    return no('rationale_vacuous', 'Article V §5.3', `A rationale of ${summary.length} characters states nothing.`);
  }
  if (/the (model|ai) (decided|determined)/i.test(summary)) {
    return no('rationale_vacuous', 'Article V §5.2', '"The model decided" is not a rationale.');
  }
  if (Object.keys(rationale.inputs ?? {}).length === 0) {
    return no('rationale_vacuous', 'Article V §5.3', 'The rationale names no inputs relied upon.');
  }
  if (!rationale.threshold?.name) {
    return no('rationale_vacuous', 'Article V §5.3', 'The rationale names no threshold applied.');
  }
  return null;
}

/** Estate-level. Always first, and always in this order. */
export function checkEstate(state: EstateState, actor: ParticipantId, counterparty: ParticipantId | null): Refusal | null {
  if (state.halted) {
    return no('ecosystem_halted', 'Article X §10.2', 'A human halt is in force. It takes effect before the next action.');
  }
  if (state.sanctionedParticipants.has(actor)) {
    return no('participant_sanctioned', 'Article XI §11.1', `${actor} is under sanction and may not act.`);
  }
  if (!state.admittedParticipants.has(actor)) {
    return no('participant_not_admitted', 'Article IX §9.2', `${actor} is not an admitted participant of the Galaxy.`);
  }
  if (counterparty !== null) {
    if (!state.admittedParticipants.has(counterparty)) {
      return no('counterparty_not_admitted', 'Article IX §9.2', `${counterparty} is not an admitted participant.`);
    }
    if (state.sanctionedParticipants.has(counterparty)) {
      // Refused for the same reason a suspended agent cannot act: a sanctioned
      // participant must not be able to complete a trade through a willing
      // counterparty.
      return no('participant_sanctioned', 'Article XI §11.1', `${counterparty} is under sanction.`);
    }
  }
  return null;
}

export function checkOffer(offer: Offer, quantity: number, now: number): Refusal | null {
  if (offer.status !== 'open' && offer.status !== 'partially_taken') {
    return no('offer_not_open', 'market', `The offer is ${offer.status}.`);
  }
  if (offer.expiresAt !== null && now > offer.expiresAt) {
    return no('offer_expired', 'market', 'The offer has expired.');
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return no('quantity_invalid', 'Article III §3.1', `Quantity ${quantity} is not a positive integer.`);
  }
  if (quantity < offer.minimumQuantity) {
    return no('quantity_below_minimum', 'market', `The seller will not break the lot below ${offer.minimumQuantity}.`);
  }
  if (quantity > offer.quantityAvailable) {
    return no('quantity_exceeds_available', 'market', `Only ${offer.quantityAvailable} remain.`);
  }
  return null;
}

/**
 * Inventory, brought into the guard chain.
 *
 * `checkOffer` asks whether the OFFER has units left. That is not the same
 * question as whether the SELLER does: one seller running an agent per channel
 * can post the same 200 render-hours to four offers, and every one of those
 * offers passes `checkOffer` while the company can deliver a quarter of what it
 * has promised.
 *
 * So the seller's own position is checked too, and it is checked here rather
 * than left to the caller, because a control that each call site must remember
 * to invoke is a control that some call site will not invoke.
 *
 * The detail and remedy are carried through verbatim from `inventory.ts` — the
 * seller who is refused needs to know which SKU and by how much, not that
 * "inventory failed".
 */
export function checkInventory(problem: { reason: string; citation: string; detail: string; remedy: string } | null): Refusal | null {
  if (!problem) return null;
  const code: GuardCode = problem.reason === 'accounting_required' || problem.reason === 'no_inventory_record'
    ? 'inventory_unaccounted'
    : 'inventory_insufficient';
  return no(code, problem.citation, `${problem.detail} ${problem.remedy}`);
}

/**
 * A price sanity band.
 *
 * Not a price control — participants may agree whatever they like. This catches
 * the fat finger and the misplaced decimal: a bid two orders of magnitude away
 * from the offer is far more likely to be an error or a compromised agent than
 * a real intention, and both parties are better served by a refusal than by a
 * settled trade neither meant.
 */
export const PRICE_BAND_MULTIPLE = 100n;

export function checkPrice(bidPrice: Minor, offerPrice: Minor): Refusal | null {
  if (bidPrice <= 0n) return no('price_invalid', 'Article III §3.1', 'A trade must clear at a positive price.');
  if (offerPrice <= 0n) return no('price_invalid', 'Article III §3.1', 'The offer has no valid price.');
  if (bidPrice > offerPrice * PRICE_BAND_MULTIPLE) {
    return no('price_implausible', 'market', `A bid more than ${PRICE_BAND_MULTIPLE}x the ask is refused as an error.`);
  }
  if (bidPrice * PRICE_BAND_MULTIPLE < offerPrice) {
    return no('price_implausible', 'market', `A bid less than 1/${PRICE_BAND_MULTIPLE} of the ask is refused as an error.`);
  }
  return null;
}

export function checkSelfDealing(seller: ParticipantId, buyer: ParticipantId): Refusal | null {
  if (seller === buyer) {
    return no('self_dealing', 'Schedule A9', 'A participant may not trade with itself; that is wash activity.');
  }
  return null;
}

/** Ceilings, enforced server-side before anything is written. */
export function checkLimits(gross: Minor, limits: ParticipantLimits): Refusal | null {
  if (gross > limits.maxOrderNotional) {
    return no('exceeds_order_ceiling', 'Article IV §4.3', 'The trade exceeds this participant\'s single-order ceiling.');
  }
  if (limits.committedToday + gross > limits.maxDailyNotional) {
    return no('exceeds_daily_exposure', 'Article IV §4.3', 'The trade would exceed the rolling 24-hour exposure ceiling.');
  }
  return null;
}

/**
 * Article III §3.5, from the seller's side. The margin floor is absolute — a
 * price that breaches it is denied, not warned about, and the campaign or
 * listing is paused.
 */
export function checkMarginFloor(unitPrice: Minor, unitCost: Minor, floorBasisPoints: number): Refusal | null {
  if (unitPrice <= 0n) return no('price_invalid', 'Article III §3.1', 'A non-positive price satisfies no floor.');
  const actual = Number(((unitPrice - unitCost) * 10_000n) / unitPrice);
  if (actual < floorBasisPoints) {
    return no(
      'below_margin_floor',
      'Article III §3.5',
      `Gross margin would be ${(actual / 100).toFixed(2)}%, below the configured floor of ` +
        `${(floorBasisPoints / 100).toFixed(2)}%. Denied, and the listing is paused.`,
    );
  }
  return null;
}

export interface AuthorisationFacts {
  serial: string | null;
  authorisedParty: ParticipantId | null;
  ceiling: Minor;
  expiresAt: number;
  /** §4.4 — who asked. Must differ from who approved. */
  requestedBy: string;
  authorisedBy: string;
}

/** Article IV. The buyer's commitment needs a receipt, and the receipt must fit. */
export function checkAuthorisation(
  auth: AuthorisationFacts,
  buyer: ParticipantId,
  gross: Minor,
  now: number,
): Refusal | null {
  if (!auth.serial) {
    return no('no_authorisation', 'Article IV §4.1', 'No comptroller authorisation receipt is bound to this trade.');
  }
  if (auth.authorisedParty !== buyer) {
    return no('authorisation_wrong_party', 'Article IV §4.5', 'The receipt is bound to a different participant.');
  }
  if (auth.requestedBy === auth.authorisedBy) {
    return no('authorisation_wrong_party', 'Article IV §4.4', 'The agent that proposed the spend also approved it.');
  }
  if (now > auth.expiresAt) {
    return no('authorisation_expired', 'Article IV §4.5', 'The authorisation receipt has expired.');
  }
  if (gross > auth.ceiling) {
    return no('authorisation_exceeded', 'Article IV §4.5', 'The trade exceeds the authorised ceiling.');
  }
  return null;
}

/**
 * Run the guards in their fixed order and return the FIRST refusal.
 *
 * First, not all of them: a caller who learns every reason their trade was
 * refused learns the shape of the counterparty's limits. One reason at a time
 * is slower to debug and much harder to map.
 */
export function firstRefusal(...checks: (Refusal | null)[]): Refusal | null {
  for (const check of checks) if (check) return check;
  return null;
}

/** Was this trade refused by something the participant can fix, or by the estate? */
export function refusedByEstate(code: GuardCode): boolean {
  return code === 'ecosystem_halted' || code === 'participant_sanctioned' ||
    code === 'participant_not_admitted' || code === 'counterparty_not_admitted';
}
