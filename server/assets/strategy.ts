/**
 * Hermes, expressed against the new ledger.
 *
 * The engine's job is unchanged — decide whether an action is permitted under
 * the zero-loss mandate — but its output is now an `ExecutionPlan` carrying a
 * SIZE, rather than a verdict on the whole position. "Sell everything" was a
 * modelling simplification; a desk sizes its orders.
 *
 * Pure. No I/O, no clock beyond what is passed in.
 */

import {
  midPrice,
  round,
  roundToLot,
  roundToTick,
  type ExecutionPlan,
  type AssetSpec,
  type Position,
  type Quote,
} from './types';

export interface StrategyPolicy {
  /** Exit if price falls this far below the average cost. */
  stopLossPct: number;
  /** Target profit over the average cost before taking any off. */
  profitTargetPct: number;
  /**
   * Fraction of the position to sell when the target is hit.
   * 1 means liquidate the lot; less means scale out.
   */
  scaleOutFraction: number;
  /** Never leave a stub smaller than this; take the rest instead. */
  minResidualFraction: number;
}

export const DEFAULT_STRATEGY: StrategyPolicy = {
  stopLossPct: 0.15,
  profitTargetPct: 0.3,
  scaleOutFraction: 0.5,
  minResidualFraction: 0.1,
};

const hold = (reason: string, diagnostics: ExecutionPlan['diagnostics'] = {}): ExecutionPlan => ({
  action: 'hold',
  reason,
  zeroLossSatisfied: false,
  diagnostics,
});

/**
 * Net proceeds per unit if we sold now at `price`, after the sell-side fee and
 * against a basis that already includes the buy-side fee.
 *
 * This is the calculation the original code got wrong: it compared raw prices
 * and multiplied by quantity, so every "profit" it reported was gross of both
 * fee legs.
 */
export function netProceedsPerUnit(instrument: AssetSpec, position: Position, price: number): number {
  return round(price * (1 - instrument.sell_fee_rate) - position.averageCost, 8);
}

export function plan(
  instrument: AssetSpec,
  position: Position,
  quote: Quote | null,
  policy: Partial<StrategyPolicy> = {},
): ExecutionPlan {
  const { stopLossPct, profitTargetPct, scaleOutFraction, minResidualFraction } = {
    ...DEFAULT_STRATEGY,
    ...policy,
  };

  if (!quote) return hold('No quote available; standing down rather than trading blind.');
  if (position.quantity <= 0) {
    return hold('Position is flat or short; this strategy only manages long inventory.', {
      quantity: position.quantity,
    });
  }

  // Sells hit the bid, not the mid and not the last trade. Marking a plan
  // against a price you cannot actually transact at is how a strategy looks
  // profitable in backtest and is not in production.
  const executable = quote.bid > 0 ? quote.bid : midPrice(quote);
  const basis = position.averageCost;
  const stopFloor = round(basis * (1 - stopLossPct), 8);
  const targetStrike = round(basis * (1 + profitTargetPct), 8);
  const netPerUnit = netProceedsPerUnit(instrument, position, executable);

  const diagnostics: ExecutionPlan['diagnostics'] = {
    bid: quote.bid,
    ask: quote.ask,
    executablePrice: executable,
    averageCost: round(basis, 8),
    stopFloor,
    targetStrike,
    netPerUnit,
    quantity: position.quantity,
  };

  // 1. Fundamental invalidation — a risk exit, explicitly not a profitable one.
  if (!instrument.fundamentals_intact) {
    return {
      action: 'place_order',
      side: 'sell',
      quantity: roundToLot(position.quantity, instrument.block_size),
      type: 'market',
      timeInForce: 'ioc',
      reason: 'Fundamental invalidation breaker: exiting the full position regardless of price.',
      zeroLossSatisfied: netPerUnit > 0,
      diagnostics,
    };
  }

  // 2. Stop loss. Also a loss-limiting exit; the zero-loss flag stays honest.
  if (executable <= stopFloor) {
    return {
      action: 'place_order',
      side: 'sell',
      quantity: roundToLot(position.quantity, instrument.block_size),
      type: 'market',
      timeInForce: 'ioc',
      reason: `Stop-loss breach: bid ${executable.toFixed(4)} at or below the floor ${stopFloor.toFixed(4)}.`,
      zeroLossSatisfied: netPerUnit > 0,
      diagnostics,
    };
  }

  // 3. Profit target on a guaranteed instrument.
  if (executable >= targetStrike && instrument.is_guaranteed) {
    if (netPerUnit <= 0) {
      return hold(
        'Bid clears the strike, but the sell-side fee erases the margin. Rejecting to preserve the zero-loss mandate.',
        diagnostics,
      );
    }

    let quantity = roundToLot(position.quantity * scaleOutFraction, instrument.block_size);

    // Do not leave an unsellable stub behind: if what would remain is below the
    // residual threshold or the venue minimum, take the whole position instead.
    const residual = round(position.quantity - quantity);
    if (
      residual > 0 &&
      (residual < instrument.min_blocks || residual < position.quantity * minResidualFraction)
    ) {
      quantity = roundToLot(position.quantity, instrument.block_size);
    }

    if (quantity < instrument.min_blocks) {
      return hold(
        `Target met, but the sized order (${quantity}) is below the venue minimum (${instrument.min_blocks}).`,
        diagnostics,
      );
    }

    // Limit at the bid: willing to take the current price, unwilling to chase
    // it down if the book moves between decision and arrival.
    const limitPrice = roundToTick(executable, instrument.price_increment, 'sell');

    return {
      action: 'place_order',
      side: 'sell',
      quantity,
      type: 'limit',
      limitPrice,
      timeInForce: 'gtc',
      reason:
        quantity >= position.quantity
          ? `Bid ${executable.toFixed(4)} clears the ${(profitTargetPct * 100).toFixed(0)}% strike and survives fees; liquidating the position.`
          : `Bid ${executable.toFixed(4)} clears the ${(profitTargetPct * 100).toFixed(0)}% strike and survives fees; scaling out ${Math.round((quantity / position.quantity) * 100)}%.`,
      zeroLossSatisfied: true,
      diagnostics: { ...diagnostics, limitPrice, sizedQuantity: quantity },
    };
  }

  return hold(
    instrument.is_guaranteed
      ? 'Within operational bounds; awaiting strike traversal.'
      : 'AssetSpec is not guaranteed, so auto-strike is disabled and manual review is required.',
    diagnostics,
  );
}
