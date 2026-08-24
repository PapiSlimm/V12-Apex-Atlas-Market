/**
 * Hermes Zero-Loss Arbitrage Engine
 * ---------------------------------
 * Pure, side-effect-free decision logic. Kept separate from the HTTP layer so
 * that BOTH `/api/hermes/evaluate` (advisory) and `/api/hermes/trade`
 * (execution) run the *same* code path. Previously the trade endpoint executed
 * blindly on client request, which let a caller realise a loss while the UI
 * still claimed a "zero-loss guarantee".
 */

export type AssetClass = 'H266_Video_NFT' | 'AudioSynth_Stream' | 'Compute_Matrix';

export interface MarketAsset {
  asset_id: string;
  name: string;
  asset_class: AssetClass;
  acquisition_price: number;
  current_price: number;
  buy_fees: number;
  sell_fees: number;
  is_guaranteed: boolean;
  fundamentals_intact: boolean;
  quantity: number;
  active_offer?: number;
  /** Marks values that come from the built-in simulator rather than a live feed. */
  simulated?: boolean;
}

export type HermesAction =
  | 'SELL_IMMEDIATELY'
  | 'EXECUTE_SELL'
  | 'HOLD_REJECT_OFFER'
  | 'HOLD_CONTINUE_MONITOR';

export interface HermesEvaluation {
  action: HermesAction;
  reason: string;
  /** Price the sell would actually clear at (the live offer, not last trade). */
  target_price?: number;
  /** Net proceeds PER UNIT after both legs of fees. */
  realized_net_per_unit?: number;
  /** Net proceeds across the whole position. */
  realized_net_total?: number;
  stop_loss_floor: number;
  target_strike: number;
  /** True only when executing right now cannot realise a loss. */
  zero_loss_satisfied: boolean;
}

export interface HermesPolicy {
  stop_loss_pct: number;
  profit_target_pct: number;
}

export const DEFAULT_POLICY: HermesPolicy = {
  stop_loss_pct: 0.15,
  profit_target_pct: 0.3,
};

/** Round to cents so float dust never decides a trade. */
const money = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * Net proceeds per unit if we sold right now at `offer`.
 * Buy-side fees are sunk into the acquisition basis; sell-side fees come off
 * the offer. Both legs must be paid before we can call anything "profit".
 */
export function netYieldPerUnit(asset: MarketAsset, offer: number): number {
  const grossOut = offer * (1 - asset.sell_fees);
  const basisIn = asset.acquisition_price * (1 + asset.buy_fees);
  return money(grossOut - basisIn);
}

export function evaluateAsset(
  asset: MarketAsset,
  policy: Partial<HermesPolicy> = {},
): HermesEvaluation {
  const { stop_loss_pct, profit_target_pct } = { ...DEFAULT_POLICY, ...policy };

  const stop_loss_floor = money(asset.acquisition_price * (1 - stop_loss_pct));
  const target_strike = money(asset.acquisition_price * (1 + profit_target_pct));

  // A position with nothing in it is not a trading opportunity.
  if (asset.quantity <= 0) {
    return {
      action: 'HOLD_CONTINUE_MONITOR',
      reason: 'Position is flat. No inventory to liquidate.',
      stop_loss_floor,
      target_strike,
      zero_loss_satisfied: false,
    };
  }

  const offer = asset.active_offer ?? asset.current_price;
  const netPerUnit = netYieldPerUnit(asset, offer);
  const netTotal = money(netPerUnit * asset.quantity);

  // 1. Fundamental invalidation breaker. Exit regardless of price -- this is a
  //    risk-control action, so it is explicitly NOT a zero-loss guarantee.
  if (!asset.fundamentals_intact) {
    return {
      action: 'SELL_IMMEDIATELY',
      reason: 'Fundamental invalidation breaker triggered. Risk exit overrides profit target.',
      target_price: offer,
      realized_net_per_unit: netPerUnit,
      realized_net_total: netTotal,
      stop_loss_floor,
      target_strike,
      zero_loss_satisfied: netPerUnit > 0,
    };
  }

  // 2. Hard stop loss. Also a loss-limiting exit, not a profitable one.
  if (asset.current_price <= stop_loss_floor) {
    return {
      action: 'SELL_IMMEDIATELY',
      reason: `Stop-loss breach at $${asset.current_price.toFixed(2)} (floor $${stop_loss_floor.toFixed(2)}).`,
      target_price: offer,
      realized_net_per_unit: netPerUnit,
      realized_net_total: netTotal,
      stop_loss_floor,
      target_strike,
      zero_loss_satisfied: netPerUnit > 0,
    };
  }

  // 3. Profit-target traversal on a guaranteed instrument.
  if (offer >= target_strike && asset.is_guaranteed) {
    if (netPerUnit > 0) {
      return {
        action: 'EXECUTE_SELL',
        reason: `Offer $${offer.toFixed(2)} clears the ${(profit_target_pct * 100).toFixed(0)}% strike ($${target_strike.toFixed(2)}) and survives both fee legs.`,
        target_price: offer,
        realized_net_per_unit: netPerUnit,
        realized_net_total: netTotal,
        stop_loss_floor,
        target_strike,
        zero_loss_satisfied: true,
      };
    }
    return {
      action: 'HOLD_REJECT_OFFER',
      reason: 'Gross offer meets the strike, but transaction fees erase the margin. Rejecting to preserve the zero-loss mandate.',
      target_price: offer,
      realized_net_per_unit: netPerUnit,
      realized_net_total: netTotal,
      stop_loss_floor,
      target_strike,
      zero_loss_satisfied: false,
    };
  }

  // 4. Nothing to do.
  return {
    action: 'HOLD_CONTINUE_MONITOR',
    reason: asset.is_guaranteed
      ? 'Asset stable within operational bounds. Awaiting strike traversal.'
      : 'Asset is not a guaranteed instrument; auto-strike is disabled and manual review is required.',
    target_price: offer,
    realized_net_per_unit: netPerUnit,
    realized_net_total: netTotal,
    stop_loss_floor,
    target_strike,
    zero_loss_satisfied: false,
  };
}

/**
 * The execution gate. `/api/hermes/trade` must call this and refuse anything
 * that does not come back `allowed: true`.
 */
export function authoriseSell(
  asset: MarketAsset,
  policy: Partial<HermesPolicy> = {},
): { allowed: boolean; evaluation: HermesEvaluation; reason: string } {
  const evaluation = evaluateAsset(asset, policy);

  if (asset.quantity <= 0) {
    return { allowed: false, evaluation, reason: 'Position is already flat.' };
  }

  // A risk exit is allowed even at a loss -- that is the point of a stop -- but
  // the caller must have asked for it explicitly by seeing SELL_IMMEDIATELY.
  if (evaluation.action === 'EXECUTE_SELL' || evaluation.action === 'SELL_IMMEDIATELY') {
    return { allowed: true, evaluation, reason: evaluation.reason };
  }

  return {
    allowed: false,
    evaluation,
    reason: `Execution refused: engine returned ${evaluation.action}. ${evaluation.reason}`,
  };
}
