/**
 * The trade lifecycle: offer → bid → acceptance → authorisation → settlement.
 *
 * THE CONCURRENCY PROBLEM THIS IS BUILT AROUND
 * --------------------------------------------
 * Two buyers accepting the same offer at the same moment must not both fill.
 * Reading `quantityAvailable`, deciding, then writing is a race with a window
 * wide enough to drive a fleet through — and the failure is an oversold seller
 * discovering they owe capacity they do not have.
 *
 * So the reservation is a compare-and-swap: the write says "reduce available
 * from 40 to 15 ONLY IF it is still 40", and the store reports how many rows it
 * changed. Zero rows means somebody won the race and this caller must re-read
 * and retry or refuse. That is the same primitive used for liquidation
 * elsewhere in this codebase, for the same reason.
 *
 * WHAT IS PURE AND WHAT IS NOT
 * ----------------------------
 * Every decision is pure and lives in `guards.ts` and `settlement.ts`. This
 * file is the thin part that sequences them and performs effects through a
 * port. That split is deliberate: the correctness is testable without a
 * database, and what remains here is ordering, which is testable with a fake.
 */

import { settle, grossFor, computeFee, type SettlementOutcome } from './settlement';
import {
  commit as commitInventory, fulfil as fulfilInventory, release as releaseInventory, requireAccounting,
  type InventoryPosition,
} from './inventory';
import {
  checkAuthorisation, checkEstate, checkInventory, checkLimits, checkMarginFloor, checkOffer, checkPrice,
  checkRationale, checkSelfDealing, firstRefusal,
  type AuthorisationFacts, type EstateState, type ParticipantLimits, type Refusal,
} from './guards';
import { DEFAULT_FEES, type Bid, type FeeSchedule, type Listing, type Offer, type ParticipantId, type SettlementRecord, type Trade } from './types';
import type { Minor } from '../constitution/money';
import type { Rationale } from '../constitution/types';

/**
 * Everything the engine needs from the outside world.
 *
 * Narrow on purpose. An engine that could reach the whole store would be an
 * engine nobody could reason about, and `reserveQuantity` returning a row count
 * rather than a boolean is what makes the compare-and-swap honest.
 */
export interface MarketPort {
  getOffer(id: string): Promise<Offer | null>;
  /**
   * Compare-and-swap. Reduces `quantityAvailable` by `quantity` ONLY IF it
   * currently equals `expected`. Returns rows changed: 1 won, 0 lost the race.
   */
  reserveQuantity(offerId: string, expected: number, quantity: number): Promise<number>;
  releaseQuantity(offerId: string, quantity: number): Promise<void>;

  saveTrade(trade: Trade): Promise<void>;
  getTrade(id: string): Promise<Trade | null>;
  /** CAS on status, so a trade settles exactly once even under concurrency. */
  markTradeSettled(id: string, expected: Trade['status'], at: number): Promise<number>;

  /** Writes both parties' legs and both audit entries in ONE transaction. */
  commitSettlement(record: SettlementRecord, trade: Trade): Promise<void>;

  estate(): Promise<EstateState>;
  limitsFor(participant: ParticipantId): Promise<ParticipantLimits>;
  authorisationFor(tradeId: string): Promise<AuthorisationFacts>;
  /** Seller's unit cost, for the margin floor. */
  unitCostFor(seller: ParticipantId, sku: string): Promise<Minor>;

  /**
   * The seller's declared ability to deliver. Null means no record exists,
   * which is itself an answer — see `requireAccounting`.
   */
  inventoryFor(participant: ParticipantId, sku: string): Promise<InventoryPosition | null>;
  /** How many times this participant has listed this SKU before. */
  priorListings(participant: ParticipantId, sku: string): Promise<number>;
  /**
   * Compare-and-swap on `updatedAt`. Returns rows changed: 1 won, 0 means
   * another agent of the same seller moved the position and the caller must
   * re-read. Not a boolean, for the same reason `reserveQuantity` is not.
   */
  saveInventory(position: InventoryPosition, expectedUpdatedAt: number): Promise<number>;
  recordListing(participant: ParticipantId, sku: string, at: number): Promise<void>;

  audit(event: {
    event: string;
    participant: ParticipantId;
    outcome: 'allowed' | 'refused';
    detail: Record<string, unknown>;
  }): Promise<void>;

  now(): number;
  newId(prefix: string): string;
}

export type MarketResult<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

const refuse = (refusal: Refusal): MarketResult<never> => ({ ok: false, refusal });

export class MarketEngine {
  constructor(
    private readonly port: MarketPort,
    private readonly fees: FeeSchedule = DEFAULT_FEES,
  ) {}

  /** Post a standing willingness to sell. */
  async postOffer(args: {
    seller: ParticipantId;
    listing: Listing;
    unitPrice: Minor;
    quantity: number;
    minimumQuantity: number;
    expiresAt: number | null;
    rationale: Rationale;
  }): Promise<MarketResult<Offer>> {
    const now = this.port.now();
    const estate = await this.port.estate();

    const unitCost = await this.port.unitCostFor(args.seller, args.listing.sku);
    const limits = await this.port.limitsFor(args.seller);

    const refusal = firstRefusal(
      checkEstate(estate, args.seller, null),
      checkRationale(args.rationale),
      args.quantity > 0 && Number.isInteger(args.quantity)
        ? null
        : { code: 'quantity_invalid' as const, citation: 'Article III §3.1', detail: 'Quantity must be a positive integer.' },
      args.unitPrice > 0n ? null : { code: 'price_invalid' as const, citation: 'Article III §3.1', detail: 'Price must be positive.' },
      // §3.5 is checked when the offer is POSTED, not only when it fills. An
      // offer that could never clear the floor should never be visible.
      checkMarginFloor(args.unitPrice, unitCost, limits.marginFloorBasisPoints),
    );
    if (refusal) {
      await this.port.audit({ event: 'market.offer.refused', participant: args.seller, outcome: 'refused', detail: { ...refusal } });
      return refuse(refusal);
    }

    /*
     * INVENTORY. The rule: if a seller offers the same product or service more
     * than once, accounting is MANDATORY — and it is checked HERE, at the door,
     * rather than at delivery.
     *
     * `checkOffer` later asks whether an OFFER has units left. That is a
     * different question from whether the SELLER does. One company running an
     * agent per channel can post the same 200 hours to four offers, and every
     * one of those offers passes `checkOffer` while the company can deliver a
     * quarter of what it has promised. The seller's own position is the only
     * place that arithmetic exists.
     */
    const priorListings = await this.port.priorListings(args.seller, args.listing.sku);
    const position = await this.port.inventoryFor(args.seller, args.listing.sku);

    const accounting = requireAccounting(
      { participant: args.seller, sku: args.listing.sku, quantity: args.quantity, priorListings },
      position,
    );
    if (!accounting.ok) {
      const inventoryRefusal = checkInventory(accounting)!;
      await this.port.audit({
        event: 'market.offer.refused', participant: args.seller, outcome: 'refused',
        detail: { ...inventoryRefusal, sku: args.listing.sku, priorListings },
      });
      return refuse(inventoryRefusal);
    }

    /*
     * Reserve the units before the offer exists.
     *
     * Bounded retry on the compare-and-swap: losing means another agent of this
     * same seller moved the position between the read and the write, and the
     * right response is to re-read and decide again rather than to overwrite a
     * reservation we never saw. Three attempts, then refuse — an unbounded
     * retry against a busy position is a spin, not a control.
     */
    if (position) {
      const reserved = await this.reserveInventory(position, args.quantity, now);
      if (!reserved.ok) {
        await this.port.audit({
          event: 'market.offer.refused', participant: args.seller, outcome: 'refused',
          detail: { ...reserved.refusal, sku: args.listing.sku },
        });
        return refuse(reserved.refusal);
      }
    }

    await this.port.recordListing(args.seller, args.listing.sku, now);

    const offer: Offer = {
      id: this.port.newId('offer'),
      seller: args.seller,
      listing: args.listing,
      unitPrice: args.unitPrice,
      quantityAvailable: args.quantity,
      minimumQuantity: args.minimumQuantity,
      status: 'open',
      postedAt: now,
      expiresAt: args.expiresAt,
      rationale: args.rationale,
    };
    await this.port.audit({
      event: 'market.offer.posted', participant: args.seller, outcome: 'allowed',
      detail: { offerId: offer.id, sku: args.listing.sku, quantity: args.quantity },
    });
    return { ok: true, value: offer };
  }

  /**
   * Accept a bid against an offer, producing a proposed trade.
   *
   * This is where the race lives. The quantity is reserved by compare-and-swap
   * BEFORE the trade is created, so a lost race costs nothing and an won one
   * cannot be double-spent.
   */
  async acceptBid(bid: Bid): Promise<MarketResult<Trade>> {
    const now = this.port.now();
    const offer = await this.port.getOffer(bid.offerId);
    if (!offer) {
      return refuse({ code: 'offer_not_open', citation: 'market', detail: 'No such offer.' });
    }

    const estate = await this.port.estate();
    const gross = (() => {
      try {
        return grossFor(bid.quantity, bid.unitPrice);
      } catch {
        return null;
      }
    })();

    if (gross === null) {
      return refuse({ code: 'quantity_invalid', citation: 'Article III §3.1', detail: 'Quantity must be a positive integer.' });
    }

    const buyerLimits = await this.port.limitsFor(bid.buyer);
    const refusal = firstRefusal(
      checkEstate(estate, bid.buyer, offer.seller),
      checkSelfDealing(offer.seller, bid.buyer),
      checkRationale(bid.rationale),
      now > bid.expiresAt ? { code: 'bid_expired' as const, citation: 'market', detail: 'The bid has expired.' } : null,
      checkOffer(offer, bid.quantity, now),
      checkPrice(bid.unitPrice, offer.unitPrice),
      checkLimits(gross, buyerLimits),
    );
    if (refusal) {
      await this.port.audit({
        event: 'market.bid.refused', participant: bid.buyer, outcome: 'refused',
        detail: { ...refusal, offerId: offer.id, bidId: bid.id },
      });
      return refuse(refusal);
    }

    // ---- the compare-and-swap. Nothing is created until this wins.
    const rows = await this.port.reserveQuantity(offer.id, offer.quantityAvailable, bid.quantity);
    if (rows !== 1) {
      const lost: Refusal = {
        code: 'quantity_exceeds_available',
        citation: 'market',
        detail: 'Another buyer took this quantity first. Re-read the offer and bid again.',
      };
      await this.port.audit({
        event: 'market.bid.lost_race', participant: bid.buyer, outcome: 'refused',
        detail: { offerId: offer.id, bidId: bid.id },
      });
      return refuse(lost);
    }

    const trade: Trade = {
      id: this.port.newId('trade'),
      offerId: offer.id,
      bidId: bid.id,
      seller: offer.seller,
      buyer: bid.buyer,
      listing: offer.listing,
      quantity: bid.quantity,
      // Clears at the OFFER price. A bid above the ask does not overpay the
      // seller by accident, and a bid below it would not have passed the band.
      unitPrice: offer.unitPrice,
      grossAmount: grossFor(bid.quantity, offer.unitPrice),
      feeAmount: computeFee(grossFor(bid.quantity, offer.unitPrice), this.fees),
      status: 'proposed',
      authorisationSerial: null,
      proposedAt: now,
      settledAt: null,
    };

    try {
      await this.port.saveTrade(trade);
    } catch (err) {
      // The reservation must not survive a failed trade write, or the offer
      // silently loses inventory to a trade that does not exist.
      await this.port.releaseQuantity(offer.id, bid.quantity);
      throw err;
    }

    await this.port.audit({
      event: 'market.trade.proposed', participant: bid.buyer, outcome: 'allowed',
      detail: { tradeId: trade.id, offerId: offer.id, quantity: trade.quantity },
    });
    return { ok: true, value: trade };
  }

  /** Bind a comptroller receipt, moving the trade to authorised. Article IV. */
  async authorise(tradeId: string): Promise<MarketResult<Trade>> {
    const trade = await this.port.getTrade(tradeId);
    if (!trade) return refuse({ code: 'no_authorisation', citation: 'market', detail: 'No such trade.' });
    if (trade.status !== 'proposed') {
      return refuse({ code: 'no_authorisation', citation: 'market', detail: `The trade is ${trade.status}.` });
    }

    const now = this.port.now();
    const auth = await this.port.authorisationFor(tradeId);
    const estate = await this.port.estate();

    const refusal = firstRefusal(
      checkEstate(estate, trade.buyer, trade.seller),
      checkAuthorisation(auth, trade.buyer, trade.grossAmount + trade.feeAmount, now),
    );
    if (refusal) {
      await this.port.audit({
        event: 'market.trade.authorisation_refused', participant: trade.buyer, outcome: 'refused',
        detail: { ...refusal, tradeId },
      });
      return refuse(refusal);
    }

    const authorised: Trade = { ...trade, status: 'authorised', authorisationSerial: auth.serial };
    await this.port.saveTrade(authorised);
    await this.port.audit({
      event: 'market.trade.authorised', participant: trade.buyer, outcome: 'allowed',
      detail: { tradeId, serial: auth.serial },
    });
    return { ok: true, value: authorised };
  }

  /**
   * Settle. Atomic, idempotent, and the only path by which money moves.
   *
   * The status compare-and-swap happens BEFORE the commit, so two concurrent
   * settle calls cannot both write. The loser sees zero rows changed and
   * returns the already-settled refusal rather than a second set of legs.
   */
  async settleTrade(tradeId: string): Promise<MarketResult<SettlementRecord>> {
    const trade = await this.port.getTrade(tradeId);
    if (!trade) return refuse({ code: 'no_authorisation', citation: 'market', detail: 'No such trade.' });

    const now = this.port.now();
    const estate = await this.port.estate();
    const estateRefusal = checkEstate(estate, trade.buyer, trade.seller);
    if (estateRefusal) {
      await this.port.audit({
        event: 'market.settlement.refused', participant: trade.buyer, outcome: 'refused',
        detail: { ...estateRefusal, tradeId },
      });
      return refuse(estateRefusal);
    }

    const outcome: SettlementOutcome = settle(trade, this.fees, now);
    if (!outcome.settled) {
      const refusal: Refusal = { code: 'no_authorisation', citation: 'Article III/IV', detail: outcome.detail };
      await this.port.audit({
        event: 'market.settlement.refused', participant: trade.buyer, outcome: 'refused',
        detail: { reason: outcome.reason, detail: outcome.detail, tradeId },
      });
      return refuse(refusal);
    }

    // Claim the trade before writing anything. Losing here is not an error —
    // it means somebody else settled it, which is the correct outcome.
    const claimed = await this.port.markTradeSettled(trade.id, 'authorised', now);
    if (claimed !== 1) {
      return refuse({
        code: 'no_authorisation',
        citation: 'Article III §3.3',
        detail: 'This trade has already been settled. A trade settles exactly once.',
      });
    }

    await this.port.commitSettlement(outcome.record, trade);
    await this.port.audit({
      event: 'market.settlement.committed', participant: trade.buyer, outcome: 'allowed',
      detail: { tradeId, digest: outcome.record.digest, gross: trade.grossAmount.toString() },
    });
    // Recorded for BOTH sides — a settlement neither party can see in their own
    // record is not a settlement they can rely on.
    await this.port.audit({
      event: 'market.settlement.committed', participant: trade.seller, outcome: 'allowed',
      detail: { tradeId, digest: outcome.record.digest, gross: trade.grossAmount.toString() },
    });

    return { ok: true, value: outcome.record };
  }

  /**
   * Reserve inventory under compare-and-swap, re-reading on a lost race.
   *
   * The retry matters more than it looks. Without it, a seller running two
   * agents sees spurious refusals whenever both post at once — and a market
   * that refuses valid offers under its own concurrency teaches sellers to
   * retry blindly, which is how you get the double-post this was protecting
   * against in the first place.
   */
  private async reserveInventory(
    position: InventoryPosition,
    quantity: number,
    now: number,
    attempts = 3,
  ): Promise<{ ok: true } | { ok: false; refusal: Refusal }> {
    let current: InventoryPosition | null = position;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!current) {
        return {
          ok: false,
          refusal: {
            code: 'inventory_unaccounted',
            citation: 'Article III §3.2',
            detail: 'The inventory record disappeared while the offer was being posted.',
          },
        };
      }

      const decided = commitInventory(current, quantity, now);
      if (!decided.ok) return { ok: false, refusal: checkInventory(decided)! };

      const rows = await this.port.saveInventory(decided.value, current.updatedAt);
      if (rows === 1) return { ok: true };

      current = await this.port.inventoryFor(current.participant, current.sku);
    }

    return {
      ok: false,
      refusal: {
        code: 'inventory_insufficient',
        citation: 'Article III §3.2',
        detail:
          `The inventory position for this SKU changed ${attempts} times while this offer was being posted. ` +
          'Another agent of yours is writing to it concurrently. Try again.',
      },
    };
  }

  /**
   * Withdraw an offer and give its unsold units back.
   *
   * The reservation must not outlive the offer. An offer withdrawn without a
   * release leaves stock held against nothing — which `reconcile` reports as
   * the seller's book quietly strangling their own supply, and which nobody
   * notices until they cannot sell goods they can see on the shelf.
   */
  async withdrawOffer(offer: Offer): Promise<MarketResult<Offer>> {
    const now = this.port.now();
    if (offer.status !== 'open' && offer.status !== 'partially_taken') {
      return refuse({ code: 'offer_not_open', citation: 'market', detail: `The offer is ${offer.status}.` });
    }

    const position = await this.port.inventoryFor(offer.seller, offer.listing.sku);
    if (position && offer.quantityAvailable > 0) {
      const released = releaseInventory(position, offer.quantityAvailable, now);
      if (released.ok) {
        // A lost race here is not an error: another writer moved the position,
        // and the release is retried on the fresh read.
        const rows = await this.port.saveInventory(released.value, position.updatedAt);
        if (rows !== 1) {
          const fresh = await this.port.inventoryFor(offer.seller, offer.listing.sku);
          if (fresh) {
            const again = releaseInventory(fresh, offer.quantityAvailable, now);
            if (again.ok) await this.port.saveInventory(again.value, fresh.updatedAt);
          }
        }
      }
    }

    await this.port.audit({
      event: 'market.offer.withdrawn', participant: offer.seller, outcome: 'allowed',
      detail: { offerId: offer.id, returned: offer.quantityAvailable },
    });
    return { ok: true, value: { ...offer, status: 'withdrawn', quantityAvailable: 0 } };
  }

  /**
   * The buyer confirmed receipt. Committed units become delivered.
   *
   * Deliberately driven by the BUYER's confirmation and not the seller's
   * assertion — a seller who could close out their own inventory against their
   * own claim of delivery would be marking their own homework with the buyer's
   * money. `agreement.ts` enforces who may say this; the engine records what it
   * means for stock.
   */
  async recordDelivery(trade: Trade): Promise<MarketResult<InventoryPosition | null>> {
    const now = this.port.now();
    const position = await this.port.inventoryFor(trade.seller, trade.listing.sku);
    if (!position) return { ok: true, value: null };

    const delivered = fulfilInventory(position, trade.quantity, now);
    if (!delivered.ok) {
      const refusal = checkInventory(delivered)!;
      await this.port.audit({
        event: 'market.delivery.accounting_break', participant: trade.seller, outcome: 'refused',
        detail: { ...refusal, tradeId: trade.id },
      });
      return refuse(refusal);
    }

    const rows = await this.port.saveInventory(delivered.value, position.updatedAt);
    if (rows !== 1) {
      return refuse({
        code: 'inventory_insufficient',
        citation: 'Article III §3.2',
        detail: 'The inventory position changed while delivery was being recorded. Re-read and record again.',
      });
    }

    await this.port.audit({
      event: 'market.delivery.recorded', participant: trade.seller, outcome: 'allowed',
      detail: { tradeId: trade.id, quantity: trade.quantity, sku: trade.listing.sku },
    });
    return { ok: true, value: delivered.value };
  }
}
