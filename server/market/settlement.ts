/**
 * Settlement — turning an accepted bid into two balanced sets of books.
 *
 * WHY THIS IS PURE
 * ----------------
 * Everything difficult about a two-party trade is arithmetic and ordering, not
 * I/O: does each side balance, does the fee split lose a penny, can the same
 * trade settle twice, does either party learn something about the other. All of
 * that is decided here, in functions with no database, no clock and no
 * randomness, so it can be property-tested over thousands of generated trades.
 *
 * The persistence layer that follows is deliberately thin: one store
 * transaction that writes what these functions produced. If the hard part is
 * pure, the transactional part has almost nothing to get wrong.
 */

import crypto from 'crypto';
import { toDecimalString, type Minor } from '../constitution/money';
import type { FeeSchedule, Leg, ParticipantId, SettlementRecord, Trade } from './types';

export class SettlementError extends Error {
  constructor(
    readonly citation: string,
    message: string,
  ) {
    super(`${citation}: ${message}`);
    this.name = 'SettlementError';
  }
}

/**
 * The market's fee, split without losing or inventing a minor unit.
 *
 * Integer division truncates, so an odd penny on a split has to go somewhere
 * explicitly. It goes to the buyer's side, and the choice is written down here
 * rather than emerging from rounding — an unassigned remainder is exactly how
 * a market's books drift by a penny a day until someone notices in year two.
 */
export function splitFee(fee: Minor, schedule: FeeSchedule): { buyer: Minor; seller: Minor } {
  if (fee < 0n) throw new SettlementError('Article III §3.1', 'a negative fee is not a fee.');
  if (schedule.bearer === 'buyer') return { buyer: fee, seller: 0n };
  if (schedule.bearer === 'seller') return { buyer: 0n, seller: fee };

  const half = fee / 2n;
  const remainder = fee - half * 2n;
  return { buyer: half + remainder, seller: half };
}

export function computeFee(gross: Minor, schedule: FeeSchedule): Minor {
  if (gross < 0n) throw new SettlementError('Article III §3.1', 'gross consideration cannot be negative.');
  // Integer basis points throughout. No float touches a fee.
  return (gross * BigInt(schedule.basisPoints)) / 10_000n;
}

/**
 * Build both parties' legs.
 *
 * The seller's books: inventory leaves, cash arrives, fee is an expense.
 * The buyer's books:  cash leaves, inventory arrives, fee is an expense.
 *
 * Each set sums to zero on its own. That is the property that matters and it is
 * asserted, not assumed — a trade where only the COMBINED legs balance would
 * mean one company's books are carrying the other's, which is not double entry,
 * it is a shared ledger with extra steps.
 */
export function buildLegs(trade: Trade, schedule: FeeSchedule): Leg[] {
  const gross = trade.grossAmount;
  const { buyer: buyerFee, seller: sellerFee } = splitFee(trade.feeAmount, schedule);

  const sellerProceeds = gross - sellerFee;
  const buyerOutlay = gross + buyerFee;

  const legs: Leg[] = [
    /*
     * ---- seller, sums to zero
     *
     * Proceeds land in `cash_held`, not `cash`. A dispute path is theatre if
     * the money has already left: by the time a buyer discovers the render
     * hours were never delivered, an unheld settlement is somebody else's
     * problem to claw back. Held funds move to `cash` only when the dispute
     * window closes without a claim — see disputes.ts `releaseEscrow`.
     */
    { participant: trade.seller, account: 'cash_held', amount: sellerProceeds, memo: `Proceeds held, ${trade.id}` },
    { participant: trade.seller, account: 'fees', amount: sellerFee, memo: `Market fee, ${trade.id}` },
    { participant: trade.seller, account: 'inventory', amount: -gross, memo: `${trade.quantity} ${trade.listing.unit} of ${trade.listing.sku}` },
    // ---- buyer, sums to zero
    { participant: trade.buyer, account: 'inventory', amount: gross, memo: `${trade.quantity} ${trade.listing.unit} of ${trade.listing.sku}` },
    { participant: trade.buyer, account: 'fees', amount: buyerFee, memo: `Market fee, ${trade.id}` },
    { participant: trade.buyer, account: 'cash', amount: -buyerOutlay, memo: `Payment, ${trade.id}` },
  ];

  assertEachSideBalances(legs, [trade.seller, trade.buyer]);
  return legs;
}

/** Article III §3.2, per party. Checked before anything is written. */
export function assertEachSideBalances(legs: Leg[], participants: ParticipantId[]): void {
  for (const participant of participants) {
    const own = legs.filter((l) => l.participant === participant);
    if (own.length < 2) {
      throw new SettlementError('Article III §3.2', `${participant} has fewer than two legs; that is not double entry.`);
    }
    const sum = own.reduce((acc, l) => acc + l.amount, 0n);
    if (sum !== 0n) {
      throw new SettlementError(
        'Article III §3.2',
        `${participant}'s legs differ by ${toDecimalString(sum)}. Each party's books must balance on their own.`,
      );
    }
  }
}

/** Deterministic digest over the settlement, so both sides can verify the same fact. */
export function settlementDigest(trade: Trade, legs: Leg[], at: number): string {
  const canonical = [
    'v12-settlement-1',
    trade.id,
    trade.seller,
    trade.buyer,
    trade.listing.sku,
    String(trade.quantity),
    trade.unitPrice.toString(),
    trade.grossAmount.toString(),
    trade.feeAmount.toString(),
    String(at),
    ...legs.map((l) => `${l.participant}|${l.account}|${l.amount.toString()}`),
  ].join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export type SettlementRefusal =
  | 'not_authorised'
  | 'already_settled'
  | 'wrong_status'
  | 'self_dealing'
  | 'quantity_invalid'
  | 'price_invalid';

export type SettlementOutcome =
  | { settled: true; record: SettlementRecord }
  | { settled: false; reason: SettlementRefusal; detail: string };

/**
 * Decide whether a trade may settle, and produce the record if so.
 *
 * Every refusal here is a refusal to WRITE, which is the only kind that counts.
 * The caller wraps this in a store transaction; if this returns a record, the
 * transaction writes it, and if it refuses, nothing was ever attempted.
 */
export function settle(trade: Trade, schedule: FeeSchedule, now: number): SettlementOutcome {
  if (trade.status === 'settled') {
    return { settled: false, reason: 'already_settled', detail: `${trade.id} settled at ${trade.settledAt}.` };
  }
  if (trade.status !== 'authorised') {
    return {
      settled: false,
      reason: 'wrong_status',
      detail: `${trade.id} is "${trade.status}". Only an authorised trade may settle.`,
    };
  }
  // Article IV §4.1 — no outbound monetary commitment without a receipt.
  if (!trade.authorisationSerial) {
    return {
      settled: false,
      reason: 'not_authorised',
      detail: 'No comptroller authorisation receipt is bound to this trade (Article IV §4.1).',
    };
  }
  /*
   * A participant trading with itself through the market would produce legs
   * that net to nothing while generating a fee and a price print. That is wash
   * activity — Schedule A9 — and it is refused structurally rather than
   * detected later by someone reading a report.
   */
  if (trade.seller === trade.buyer) {
    return {
      settled: false,
      reason: 'self_dealing',
      detail: 'Seller and buyer are the same participant. Schedule A9: wash activity is prohibited.',
    };
  }
  if (!Number.isInteger(trade.quantity) || trade.quantity <= 0) {
    return { settled: false, reason: 'quantity_invalid', detail: `quantity ${trade.quantity} is not a positive integer.` };
  }
  if (trade.unitPrice <= 0n || trade.grossAmount <= 0n) {
    return { settled: false, reason: 'price_invalid', detail: 'a trade must clear at a positive price.' };
  }

  const legs = buildLegs(trade, schedule);
  return {
    settled: true,
    record: { tradeId: trade.id, at: now, legs, digest: settlementDigest(trade, legs, now) },
  };
}

/** Gross consideration. Integer throughout — quantity is a count, price is minor units. */
export function grossFor(quantity: number, unitPrice: Minor): Minor {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new SettlementError('Article III §3.1', `quantity ${quantity} is not a positive integer.`);
  }
  return BigInt(quantity) * unitPrice;
}
