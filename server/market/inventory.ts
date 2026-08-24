/**
 * Inventory accounting — because an agent that can sell the same thing twice
 * will eventually sell it twice.
 *
 * THE RULE THIS FILE IMPLEMENTS
 * -----------------------------
 *   If a seller offers the same product or service more than once, inventory
 *   accounting is MANDATORY.
 *
 * Not encouraged, not a best practice for serious sellers — a precondition of
 * posting the offer. A seller with no inventory record for a SKU they have
 * already listed is refused, and the refusal says exactly what to declare.
 *
 * WHY THIS IS THE LOAD-BEARING CONTROL IN AN AGENT MARKET
 * ------------------------------------------------------
 * Every other integrity control here assumes the goods exist. Guards check
 * price, limits and authorisation; settlement checks that the money balances;
 * escrow checks that the buyer confirmed receipt. None of them notice a seller
 * whose agent has posted the same 200 render-hours to four counterparties
 * simultaneously, because each of the four trades is individually perfect.
 *
 * That is not an exotic attack. It is the ordinary failure mode of automation:
 * an agent optimising for filled orders, with no view of what its own company
 * has already promised, will promise it again. The buyer discovers it at
 * delivery, which is the most expensive possible moment.
 *
 * Overselling is also how a market's price signal dies. Supply that does not
 * exist still prints, still moves the price, and still builds reputation — the
 * same damage as wash trading, arrived at by negligence rather than intent.
 *
 * THREE KINDS OF THING, AND THEY ACCOUNT DIFFERENTLY
 * -------------------------------------------------
 * Treating a licence like a pallet is what makes inventory systems unusable for
 * services, and it is the reason sellers switch them off.
 *
 *   DEPLETING  — a finite stock that goes away when sold. Pallets, surplus GPUs,
 *                a footage library sold outright. Sell 10 of 100, 90 remain.
 *
 *   RENEWABLE  — capacity per period. Studio time, render hours, bandwidth,
 *                consulting days. 40 hours a week is 40 hours EVERY week and
 *                zero hours carried forward, and the commonest real oversell is
 *                selling next week's capacity as though it were this week's.
 *
 *   ISSUABLE   — something that can be issued repeatedly without depleting:
 *                a licence, a template, a dataset copy. Here the user's rule
 *                still binds. Non-depleting is not the same as unaccounted:
 *                every issuance is counted, because a seller who cannot say how
 *                many licences they have issued cannot answer an audit, cannot
 *                honour an exclusivity term, and cannot detect a compromised
 *                agent issuing thousands.
 *
 * WHAT THIS FILE DOES NOT DO
 * --------------------------
 * It does not decide whether the seller's declared stock is TRUE. Nothing in
 * software can. What it does is make the claim explicit, count against it, and
 * make the discrepancy visible the moment the arithmetic stops working —
 * `reconcile` compares the record against what the trades actually say, and
 * `detectPhantomSupply` compares open offers against declared stock. A seller
 * can still lie; they can no longer do it silently, and they cannot do it by
 * accident.
 */

import type { Finding, Severity } from './collusion';
import type { ParticipantId } from './types';

export type SkuKind = 'depleting' | 'renewable' | 'issuable';

export interface InventoryPosition {
  participant: ParticipantId;
  sku: string;
  kind: SkuKind;
  /**
   * Units the seller declares they can deliver.
   *
   * DEPLETING: stock on hand. RENEWABLE: the period's capacity. ISSUABLE:
   * ignored — see `issuanceCap`.
   */
  onHand: number;
  /** Reserved against open offers and agreed-but-undelivered trades. */
  committed: number;
  /** Delivered and confirmed. Depleting stock has already left `onHand`. */
  delivered: number;
  /** RENEWABLE only. Capacity belongs to a period and does not carry forward. */
  periodStart: number | null;
  periodEnd: number | null;
  /** ISSUABLE only. `null` is unlimited issuance — still counted, never uncounted. */
  issuanceCap: number | null;
  /** ISSUABLE only. Every issuance, for ever. */
  issued: number;
  updatedAt: number;
}

export type InventoryRefusal =
  | 'accounting_required'
  | 'no_inventory_record'
  | 'quantity_invalid'
  | 'oversold'
  | 'capacity_period_stale'
  | 'capacity_exhausted'
  | 'issuance_cap_reached'
  | 'not_committed'
  | 'kind_mismatch';

export interface InventoryProblem {
  reason: InventoryRefusal;
  citation: string;
  detail: string;
  /** What the seller must do. A refusal a seller cannot act on stops the market. */
  remedy: string;
}

export type InventoryOutcome<T> = { ok: true; value: T } | ({ ok: false } & InventoryProblem);

const no = (reason: InventoryRefusal, citation: string, detail: string, remedy: string): InventoryOutcome<never> => ({
  ok: false,
  reason,
  citation,
  detail,
  remedy,
});

/* ------------------------------------------------------------------ *
 * The mandatory-accounting rule
 * ------------------------------------------------------------------ */

export interface ListingIntent {
  participant: ParticipantId;
  sku: string;
  /** How many units this offer puts up. */
  quantity: number;
  /** How many times this participant has already listed this SKU. */
  priorListings: number;
}

/**
 * Is inventory accounting mandatory for this listing, and does it exist?
 *
 * "Selling the same product or service more than once" is either of two shapes,
 * and both are caught:
 *
 *   - a lot of MORE THAN ONE UNIT, which is the same service sold repeatedly
 *     inside a single offer; or
 *   - a SKU this participant HAS LISTED BEFORE, which is the same service sold
 *     repeatedly across offers.
 *
 * A genuine one-off — a single unique item, listed once — may proceed without a
 * record, because requiring a stock ledger to sell one used camera is the kind
 * of ceremony that drives sellers to a market with less of it. Everything else
 * needs the record first.
 */
export function requireAccounting(
  intent: ListingIntent,
  position: InventoryPosition | null,
): InventoryOutcome<{ mandatory: boolean }> {
  if (!Number.isInteger(intent.quantity) || intent.quantity <= 0) {
    return no(
      'quantity_invalid',
      'Article III §3.1',
      `A listing of ${intent.quantity} units is not a listing.`,
      'State a positive whole number of units.',
    );
  }

  const repeat = intent.quantity > 1 || intent.priorListings > 0;
  if (!repeat) return { ok: true, value: { mandatory: false } };

  if (!position) {
    return no(
      'accounting_required',
      'Article III §3.2',
      intent.quantity > 1
        ? `${intent.participant} is offering ${intent.quantity} units of ${intent.sku} with no inventory record. ` +
            'Selling the same service more than once without accounting for it is how a market ends up with supply ' +
            'that does not exist.'
        : `${intent.participant} has listed ${intent.sku} ${intent.priorListings} time(s) before and holds no ` +
            'inventory record. A repeat listing without accounting cannot be distinguished from selling the same ' +
            'unit twice.',
      `Declare an inventory position for ${intent.sku}: its kind (depleting, renewable or issuable) and how much ` +
        'you can actually deliver.',
    );
  }
  if (position.sku !== intent.sku || position.participant !== intent.participant) {
    return no(
      'no_inventory_record',
      'Article III §3.2',
      'The inventory record presented belongs to a different SKU or participant.',
      'Present the record for this SKU.',
    );
  }
  return { ok: true, value: { mandatory: true } };
}

/* ------------------------------------------------------------------ *
 * Availability
 * ------------------------------------------------------------------ */

/**
 * How many units may still be committed.
 *
 * RENEWABLE capacity outside its period is ZERO, not last period's remainder.
 * The seller must roll the period deliberately, which is the whole point: the
 * commonest real oversell is an agent quietly selling next week's studio time
 * as though the calendar had not moved.
 */
export function available(position: InventoryPosition, now: number): number {
  if (position.kind === 'issuable') {
    if (position.issuanceCap === null) return Number.MAX_SAFE_INTEGER;
    return Math.max(0, position.issuanceCap - position.issued - position.committed);
  }
  if (position.kind === 'renewable') {
    const inPeriod =
      position.periodStart !== null && position.periodEnd !== null && now >= position.periodStart && now <= position.periodEnd;
    if (!inPeriod) return 0;
  }
  return Math.max(0, position.onHand - position.committed);
}

/**
 * May this seller commit `quantity` units?
 *
 * This is the check that stops the same unit being sold twice, and it is
 * deliberately arithmetic rather than heuristic: two open offers drawing on one
 * position cannot both reserve the same unit, because `committed` is a single
 * number on a single record.
 */
export function checkAvailability(
  position: InventoryPosition,
  quantity: number,
  now: number,
): InventoryOutcome<{ remaining: number }> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return no('quantity_invalid', 'Article III §3.1', `Quantity ${quantity} is not a positive whole number.`, 'State whole units.');
  }

  if (position.kind === 'renewable') {
    const stale =
      position.periodStart === null || position.periodEnd === null || now < position.periodStart || now > position.periodEnd;
    if (stale) {
      return no(
        'capacity_period_stale',
        'Article III §3.2',
        `${position.sku} is renewable capacity and the record's period ` +
          `${position.periodEnd === null ? 'is not set' : `ended ${new Date(position.periodEnd).toISOString()}`}. ` +
          'Capacity does not carry forward; last period\'s unsold hours are gone, not available.',
        'Roll the period and state this period\'s capacity before selling into it.',
      );
    }
  }

  const remaining = available(position, now);
  if (quantity > remaining) {
    if (position.kind === 'issuable') {
      return no(
        'issuance_cap_reached',
        'Article III §3.2',
        `${position.sku} has an issuance cap of ${position.issuanceCap}; ${position.issued} issued and ` +
          `${position.committed} committed leave ${remaining}. A cap is usually an exclusivity term someone was sold.`,
        'Raise the cap deliberately, or stop issuing.',
      );
    }
    if (position.kind === 'renewable') {
      return no(
        'capacity_exhausted',
        'Article III §3.2',
        `${position.sku} has ${remaining} of this period's ${position.onHand} units uncommitted; ${quantity} were ` +
          'requested. Selling capacity you have already promised is overselling however good the intention.',
        'Sell into a later period, or reduce the quantity.',
      );
    }
    return no(
      'oversold',
      'Article III §3.2',
      `${position.sku} has ${position.onHand} on hand with ${position.committed} already committed, leaving ` +
        `${remaining}. Committing ${quantity} would promise stock that does not exist.`,
      'Reduce the quantity, or increase the declared stock if it is genuinely there.',
    );
  }

  return { ok: true, value: { remaining: remaining - quantity } };
}

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

/**
 * Reserve units. Called when an offer is posted or a proposal is agreed.
 *
 * Pure: returns a new position rather than mutating one. The caller writes it
 * through `store.transaction()` with a compare-and-swap on `updatedAt`, the same
 * way `reserveQuantity` guards an offer — otherwise two agents of the same
 * seller can both read 100 available and both commit 100.
 */
export function commit(position: InventoryPosition, quantity: number, now: number): InventoryOutcome<InventoryPosition> {
  const check = checkAvailability(position, quantity, now);
  if (!check.ok) return check;
  return { ok: true, value: { ...position, committed: position.committed + quantity, updatedAt: now } };
}

/** Give units back — a withdrawn offer, a declined proposal, an expired bid. */
export function release(position: InventoryPosition, quantity: number, now: number): InventoryOutcome<InventoryPosition> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return no('quantity_invalid', 'Article III §3.1', `Quantity ${quantity} is not a positive whole number.`, 'State whole units.');
  }
  if (quantity > position.committed) {
    return no(
      'not_committed',
      'Article III §3.2',
      `Releasing ${quantity} units of ${position.sku} against ${position.committed} committed would invent stock.`,
      'Release only what was reserved.',
    );
  }
  return { ok: true, value: { ...position, committed: position.committed - quantity, updatedAt: now } };
}

/**
 * Delivery confirmed by the buyer. Committed units become delivered.
 *
 * Depleting stock leaves `onHand` here and not before: until the buyer confirms
 * receipt the goods are promised, not gone, and a seller whose buyer disputes
 * gets their stock back rather than a hole in the ledger.
 */
export function fulfil(position: InventoryPosition, quantity: number, now: number): InventoryOutcome<InventoryPosition> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return no('quantity_invalid', 'Article III §3.1', `Quantity ${quantity} is not a positive whole number.`, 'State whole units.');
  }
  if (quantity > position.committed) {
    return no(
      'not_committed',
      'Article III §3.2',
      `${quantity} units of ${position.sku} were delivered but only ${position.committed} were ever committed. ` +
        'Delivery of uncommitted stock means something bypassed the reservation.',
      'Investigate: this is an accounting break, not a rounding difference.',
    );
  }
  const next: InventoryPosition = {
    ...position,
    committed: position.committed - quantity,
    delivered: position.delivered + quantity,
    updatedAt: now,
  };
  if (position.kind === 'issuable') {
    return { ok: true, value: { ...next, issued: position.issued + quantity } };
  }
  return { ok: true, value: { ...next, onHand: position.onHand - quantity } };
}

/**
 * Start a new period for renewable capacity.
 *
 * Uncommitted capacity does NOT carry forward, and committed capacity does not
 * silently vanish: rolling a period with commitments still open is refused,
 * because those are promises for the period being closed and someone has to
 * decide what happens to them.
 */
export function rollPeriod(
  position: InventoryPosition,
  args: { capacity: number; periodStart: number; periodEnd: number; now: number },
): InventoryOutcome<InventoryPosition> {
  if (position.kind !== 'renewable') {
    return no(
      'kind_mismatch',
      'Article III §3.2',
      `${position.sku} is ${position.kind}; only renewable capacity has periods.`,
      'Adjust stock directly instead.',
    );
  }
  if (!Number.isInteger(args.capacity) || args.capacity < 0) {
    return no('quantity_invalid', 'Article III §3.1', 'Capacity must be a whole number of units.', 'State whole units.');
  }
  if (args.periodEnd <= args.periodStart) {
    return no('quantity_invalid', 'Article III §3.1', 'A period must end after it starts.', 'Correct the dates.');
  }
  if (position.committed > 0) {
    return no(
      'not_committed',
      'Article III §3.2',
      `${position.committed} units of ${position.sku} are still committed in the period being closed. Rolling now ` +
        'would leave promises attached to capacity that no longer exists.',
      'Deliver, release or dispute the outstanding commitments first.',
    );
  }
  return {
    ok: true,
    value: {
      ...position,
      onHand: args.capacity,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      updatedAt: args.now,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Reconciliation and detection
 * ------------------------------------------------------------------ */

export interface SkuActivity {
  /** Units reserved against offers and agreed proposals still outstanding. */
  openCommitments: number;
  /** Units the trade record says were delivered and confirmed. */
  confirmedDeliveries: number;
}

export interface InventoryBreak {
  sku: string;
  participant: ParticipantId;
  field: 'committed' | 'delivered';
  recorded: number;
  observed: number;
  detail: string;
}

/**
 * Does the inventory record agree with what the trades actually say?
 *
 * The record is the seller's claim; the trades are what happened. When they
 * disagree the record is wrong, and it is worth being precise about which
 * direction, because the two mean opposite things:
 *
 *   recorded < observed — the seller has promised more than their book shows.
 *     Something committed stock without going through the reservation.
 *
 *   recorded > observed — the book is holding stock nothing is claiming.
 *     Usually a release that never happened, which quietly strangles supply.
 */
export function reconcile(position: InventoryPosition, activity: SkuActivity): InventoryBreak[] {
  const breaks: InventoryBreak[] = [];

  if (position.committed !== activity.openCommitments) {
    breaks.push({
      sku: position.sku,
      participant: position.participant,
      field: 'committed',
      recorded: position.committed,
      observed: activity.openCommitments,
      detail:
        position.committed < activity.openCommitments
          ? `${activity.openCommitments - position.committed} units are promised on open offers and trades that the ` +
            'inventory record does not show as committed. Something reserved stock outside the reservation path.'
          : `${position.committed - activity.openCommitments} units are held as committed with nothing claiming ` +
            'them. A release was missed, and that stock is unsellable until it is found.',
    });
  }

  if (position.delivered !== activity.confirmedDeliveries) {
    breaks.push({
      sku: position.sku,
      participant: position.participant,
      field: 'delivered',
      recorded: position.delivered,
      observed: activity.confirmedDeliveries,
      detail:
        `The record shows ${position.delivered} units delivered; buyers have confirmed ${activity.confirmedDeliveries}. ` +
        'Delivery is confirmed by the buyer, so the trades are the fact and the record is the claim.',
    });
  }

  return breaks;
}

export interface OpenOfferQuantity {
  offerId: string;
  sku: string;
  quantity: number;
}

/**
 * Supply on the board that the seller's own record cannot support.
 *
 * This is the market-wide view of the same arithmetic: sum every open offer for
 * a SKU and compare against what is declared. A seller running one agent per
 * channel, each posting the whole stock, trips this immediately — and that
 * configuration is common, accidental, and indistinguishable from fraud to the
 * buyer who does not get their goods.
 *
 * Severity is `serious` rather than `critical`: it is usually a broken agent
 * rather than a criminal, and this module reports while the enforcement engine
 * decides.
 */
export function detectPhantomSupply(
  position: InventoryPosition,
  openOffers: OpenOfferQuantity[],
  now: number,
): Finding[] {
  const forSku = openOffers.filter((o) => o.sku === position.sku);
  const offered = forSku.reduce((sum, o) => sum + o.quantity, 0);
  const capacity = position.kind === 'issuable' && position.issuanceCap === null
    ? Number.MAX_SAFE_INTEGER
    : available(position, now) + position.committed;

  if (offered <= capacity) return [];

  return [{
    signal: 'phantom_supply',
    severity: 'serious' as Severity,
    citation: 'Article III §3.2',
    detail:
      `${position.participant} has ${forSku.length} open offers for ${position.sku} totalling ${offered} units ` +
      `against declared capacity of ${capacity}. ${offered - capacity} units are on the board that cannot be ` +
      'delivered. Each offer is individually valid, which is why nothing else catches this.',
    participants: [position.participant],
  }];
}

/**
 * A seller listing repeatedly with no record at all.
 *
 * `requireAccounting` refuses the listing at the door. This is the surveillance
 * view for whoever governs the market: a participant who keeps arriving at that
 * door is either misconfigured or testing whether the rule is real.
 */
export function detectUnaccountedRepeatSelling(
  participant: ParticipantId,
  listingsBySku: Record<string, number>,
  hasRecord: (sku: string) => boolean,
): Finding[] {
  const offending = Object.entries(listingsBySku)
    .filter(([sku, count]) => count > 1 && !hasRecord(sku))
    .map(([sku, count]) => `${sku} (${count})`);

  if (offending.length === 0) return [];

  return [{
    signal: 'inventory_unaccounted',
    severity: 'moderate' as Severity,
    citation: 'Article III §3.2',
    detail:
      `${participant} has listed ${offending.join(', ')} more than once with no inventory record. Repeat selling ` +
      'without accounting cannot be distinguished from selling the same unit twice, which is why the record is ' +
      'mandatory rather than advisory.',
    participants: [participant],
  }];
}

/** Plain language, for the seller and for the log. */
export function describePosition(position: InventoryPosition, now: number): string {
  const head = `${position.participant} · ${position.sku} (${position.kind})`;
  if (position.kind === 'issuable') {
    const cap = position.issuanceCap === null ? 'uncapped' : `cap ${position.issuanceCap}`;
    return `${head}: ${position.issued} issued, ${position.committed} committed, ${cap}. Every issuance is counted.`;
  }
  if (position.kind === 'renewable') {
    const period =
      position.periodStart === null || position.periodEnd === null
        ? 'no period set — nothing sellable'
        : `period ${new Date(position.periodStart).toISOString()} → ${new Date(position.periodEnd).toISOString()}`;
    return `${head}: ${available(position, now)} of ${position.onHand} uncommitted this period, ${position.committed} committed. ${period}. Capacity does not carry forward.`;
  }
  return `${head}: ${position.onHand} on hand, ${position.committed} committed, ${available(position, now)} sellable, ${position.delivered} delivered.`;
}
