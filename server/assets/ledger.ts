/**
 * Position accounting.
 *
 * Pure functions over an ordered sequence of fills. No I/O, no clock, no
 * randomness — so it can be property-tested exhaustively, which is the only
 * way to trust money arithmetic across partial fills.
 *
 * THE INVARIANT
 * -------------
 * For every position, at every point in the fill sequence:
 *
 *     realisedPnl - quantity * averageCost === cashFlow
 *
 * That single identity ties the three numbers a trader cares about to the cash
 * that actually moved. It holds for longs, for shorts, and across a position
 * that crosses through zero. `tests/ledger.test.ts` asserts it after every fill
 * of thousands of randomised sequences; if fee apportionment or basis
 * maintenance is wrong anywhere, it breaks immediately.
 *
 * The original code computed profit as `(current_price - acquisition_price) *
 * quantity`, which has no basis maintenance, no fee handling and no concept of
 * a partial reduction. It produced plausible, wrong numbers.
 */

import {
  emptyPosition,
  isTerminal,
  round,
  type Fill,
  type Order,
  type OrderStatus,
  type Position,
} from './types';

/**
 * `averageCost` is the average cash per unit of exposure, fees included,
 * always expressed as a positive number:
 *
 *   - long  → average price PAID per unit, plus its share of buy fees
 *   - short → average net proceeds RECEIVED per unit, less its share of fees
 *
 * Under both readings, "increasing exposure" updates the average and
 * "reducing exposure" realises against it and leaves it untouched. That is what
 * makes one code path correct for both directions.
 */
export function applyFill(position: Position, fill: Fill): Position {
  const signedDelta = fill.side === 'buy' ? fill.quantity : -fill.quantity;
  if (fill.quantity <= 0) return position;

  const next: Position = {
    ...position,
    feesPaid: round(position.feesPaid + fill.fee),
    // Cash out on a buy (price plus fee), cash in on a sell (price less fee).
    cashFlow: round(
      position.cashFlow +
        (fill.side === 'buy' ? -(fill.price * fill.quantity + fill.fee) : fill.price * fill.quantity - fill.fee),
    ),
    fillCount: position.fillCount + 1,
    lastFillAt: fill.timestamp,
  };

  const currentQty = position.quantity;
  const sameDirection = currentQty === 0 || Math.sign(currentQty) === Math.sign(signedDelta);

  if (sameDirection) {
    // Opening or adding. Blend the new lot into the average.
    const absCurrent = Math.abs(currentQty);
    const absDelta = Math.abs(signedDelta);
    const cashPerLot =
      fill.side === 'buy'
        ? fill.price * absDelta + fill.fee // paid
        : fill.price * absDelta - fill.fee; // received

    const blended = (position.averageCost * absCurrent + cashPerLot) / (absCurrent + absDelta);

    next.quantity = round(currentQty + signedDelta);
    // Deliberately NOT rounded. `averageCost` is a derived ratio, not an amount
    // that moves; rounding it to 8dp injects an error of up to 5e-9 PER UNIT,
    // which a large position multiplies into a visible discrepancy. The
    // property test caught exactly this: a 115-unit position drifted 1.0e-6
    // out of balance purely from rounding the basis. Amounts that correspond to
    // real cash — cashFlow, realisedPnl, feesPaid — are still rounded.
    next.averageCost = blended;
    return next;
  }

  // Opposite direction: reduce, and possibly cross through zero.
  const closingQty = Math.min(Math.abs(signedDelta), Math.abs(currentQty));
  const remainderQty = round(Math.abs(signedDelta) - closingQty);

  // Fees are apportioned pro rata across the closing and opening halves, so a
  // fill that crosses zero does not charge the whole fee to whichever side
  // happens to be evaluated first.
  const closingFee = round((fill.fee * closingQty) / Math.abs(signedDelta));
  const openingFee = round(fill.fee - closingFee);

  const realised =
    currentQty > 0
      ? // Closing a long: proceeds less fee, against what we paid.
        fill.price * closingQty - closingFee - position.averageCost * closingQty
      : // Closing a short: what we received, against the cost to buy back.
        position.averageCost * closingQty - (fill.price * closingQty + closingFee);

  next.realisedPnl = round(position.realisedPnl + realised);
  next.quantity = round(currentQty + signedDelta);

  if (remainderQty > 0) {
    // Crossed through flat and opened the other way. The new leg's basis is
    // built only from the remainder and its share of the fee.
    const cashPerLot =
      fill.side === 'buy' ? fill.price * remainderQty + openingFee : fill.price * remainderQty - openingFee;
    next.averageCost = cashPerLot / remainderQty;
  } else if (next.quantity === 0) {
    next.averageCost = 0;
  }
  // Partial reduction leaves the basis of the surviving units unchanged.

  return next;
}

/** Fold an ordered sequence of fills into a position. */
export function derivePosition(assetId: string, fills: Fill[]): Position {
  return sortFills(fills).reduce(applyFill, emptyPosition(assetId));
}

/**
 * Fills are ordered by the venue's own sequence where it provides one, because
 * venue and local clocks disagree and ordering by our clock can place a fill
 * before the order that produced it. Timestamp is the fallback, and the fill id
 * is the final tie-break so the ordering is total and therefore deterministic.
 */
export function sortFills(fills: Fill[]): Fill[] {
  return [...fills].sort((a, b) => {
    if (a.sequence !== null && b.sequence !== null && a.sequence !== b.sequence) {
      return a.sequence - b.sequence;
    }
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Mark-to-market value of the open exposure. */
export function unrealisedPnl(position: Position, markPrice: number): number {
  if (position.quantity === 0) return 0;
  return position.quantity > 0
    ? round((markPrice - position.averageCost) * position.quantity)
    : round((position.averageCost - markPrice) * Math.abs(position.quantity));
}

/**
 * The books-balance check, exposed so callers (and health checks) can assert it.
 *
 * The tolerance is relative as well as absolute. A fixed absolute epsilon is
 * wrong for a quantity with no bound: 1e-6 is generous on a $100 position and
 * impossibly strict on a $100M one. Residual float error scales with magnitude,
 * so the tolerance must too.
 */
export function reconciles(position: Position, absoluteTolerance = 1e-6): boolean {
  const lhs = position.realisedPnl - position.quantity * position.averageCost;
  const scale = Math.max(Math.abs(position.cashFlow), Math.abs(lhs));
  const tolerance = Math.max(absoluteTolerance, scale * 1e-9);
  return Math.abs(lhs - position.cashFlow) <= tolerance;
}

// ---------------------------------------------------------------------------
// Order roll-up
// ---------------------------------------------------------------------------

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`Illegal order transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/**
 * Recompute an order's aggregate fields from its fills.
 *
 * Status is derived, never assigned from outside: an order is `filled` when its
 * fills say so and not because a venue message claimed it. That way a duplicate
 * or out-of-order venue update cannot move an order into a state its fills do
 * not support.
 */
export function applyFillsToOrder(order: Order, fills: Fill[]): Order {
  const mine = sortFills(fills.filter((f) => f.clientOrderId === order.clientOrderId));

  const filledQuantity = round(mine.reduce((sum, f) => sum + f.quantity, 0));
  const notional = mine.reduce((sum, f) => sum + f.price * f.quantity, 0);
  const feesPaid = round(mine.reduce((sum, f) => sum + f.fee, 0));
  const averageFillPrice = filledQuantity > 0 ? round(notional / filledQuantity) : 0;

  let status: OrderStatus = order.status;
  if (!isTerminal(order.status)) {
    if (filledQuantity <= 0) {
      status = order.status === 'pending' ? 'pending' : 'working';
    } else if (filledQuantity >= round(order.quantity) - 1e-9) {
      status = 'filled';
    } else {
      status = 'partially_filled';
    }
  }

  return {
    ...order,
    filledQuantity,
    averageFillPrice,
    feesPaid,
    status,
    updatedAt: mine.length > 0 ? mine[mine.length - 1].receivedAt : order.updatedAt,
  };
}

/** Remaining quantity an order can still take. */
export function remainingQuantity(order: Order): number {
  return round(Math.max(0, order.quantity - order.filledQuantity));
}
