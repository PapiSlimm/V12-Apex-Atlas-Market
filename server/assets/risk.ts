/**
 * Pre-settlement risk controls.
 *
 * Every order passes through `assess()` before it reaches the marketplace. The checks
 * are pure functions of explicit inputs — no clock reads, no I/O — so the whole
 * policy is testable and every rejection carries the numbers that produced it.
 *
 * DESIGN NOTE
 * -----------
 * These are all *pre-trade* checks and they are all *refusals*. Nothing here
 * modifies an order to make it acceptable. A risk layer that silently resizes
 * orders is a risk layer nobody can reason about: the operator asked for one
 * thing, the venue got another, and the audit log has to explain a number
 * nobody chose. Sizing happens upstream, in the plan; this layer only says yes
 * or no, and says why.
 */

import { quoteAgeMs, round, type AssetSpec, type OrderIntent, type Position, type Quote } from './types';

export interface RiskLimits {
  /** Hard stop. When true, nothing executes, regardless of everything else. */
  halted: boolean;
  haltReason?: string;
  /** Largest notional a single order may carry. */
  maxOrderNotional: number;
  /** Largest cumulative notional across a rolling day. */
  maxDailyNotional: number;
  /** Largest absolute notional a single position may reach. */
  maxPositionNotional: number;
  /** Refuse to trade on a quote older than this. */
  maxQuoteAgeMs: number;
  /**
   * Refuse a quote that deviates from the last known good price by more than
   * this fraction. Bad market data has caused more losses than bad logic.
   */
  maxPriceDeviation: number;
}

export const DEFAULT_LIMITS: RiskLimits = {
  halted: false,
  maxOrderNotional: 250_000,
  maxDailyNotional: 1_000_000,
  maxPositionNotional: 500_000,
  maxQuoteAgeMs: 5_000,
  maxPriceDeviation: 0.2,
};

export interface RiskContext {
  spec: AssetSpec;
  quote: Quote | null;
  position: Position;
  /** Notional already traded in the rolling window. */
  dailyNotionalUsed: number;
  /** Last price we trusted, for the sanity band. */
  referencePrice: number | null;
  mode: 'internal' | 'galaxy';
  now: number;
}

export interface RiskVerdict {
  allowed: boolean;
  /** Every failed check, not just the first — an operator fixing one wants to see the rest. */
  violations: { code: string; message: string; observed: number | string; limit: number | string }[];
  notional: number;
  quoteAgeMs: number | null;
}

export function assess(intent: OrderIntent, limits: RiskLimits, ctx: RiskContext): RiskVerdict {
  const violations: RiskVerdict['violations'] = [];

  const referencePx = intent.limitPrice ?? ctx.quote?.last ?? ctx.referencePrice ?? 0;
  const notional = round(Math.abs(intent.quantity * referencePx), 2);
  const ageMs = ctx.quote ? quoteAgeMs(ctx.quote, ctx.now) : null;

  const fail = (code: string, message: string, observed: number | string, limit: number | string) =>
    violations.push({ code, message, observed, limit });

  // The kill switch is checked first and is not overridable by anything below.
  if (limits.halted) {
    fail('halted', limits.haltReason || 'Settlement is halted by the kill switch.', 'halted', 'running');
  }

  // ---- instrument sanity -------------------------------------------------
  if (intent.quantity <= 0) {
    fail('quantity_non_positive', 'Order quantity must be positive.', intent.quantity, '> 0');
  }
  if (intent.quantity > 0 && intent.quantity < ctx.spec.min_blocks) {
    fail(
      'below_min_quantity',
      'Order is smaller than the marketplace minimum.',
      intent.quantity,
      ctx.spec.min_blocks,
    );
  }
  if (ctx.spec.block_size > 0) {
    const lots = intent.quantity / ctx.spec.block_size;
    if (Math.abs(lots - Math.round(lots)) > 1e-9) {
      fail('block_size', 'Order quantity is not a whole number of lots.', intent.quantity, ctx.spec.block_size);
    }
  }
  if (intent.type === 'limit' && !(intent.limitPrice! > 0)) {
    fail('limit_price_required', 'A limit order requires a positive limit price.', String(intent.limitPrice), '> 0');
  }

  // ---- market data quality ----------------------------------------------
  // A stale or implausible price is a reason to stand down, not to guess.
  if (!ctx.quote) {
    fail('no_quote', 'No bid available for this asset class.', 'none', 'a quote');
  } else {
    if (ageMs !== null && ageMs > limits.maxQuoteAgeMs) {
      fail('stale_quote', 'Quote is older than the staleness threshold.', `${ageMs}ms`, `${limits.maxQuoteAgeMs}ms`);
    }
    if (!(ctx.quote.bid > 0) || !(ctx.quote.ask > 0) || ctx.quote.ask < ctx.quote.bid) {
      fail('crossed_quote', 'Quote is crossed or non-positive.', `${ctx.quote.bid}/${ctx.quote.ask}`, 'bid <= ask');
    }
    if (ctx.referencePrice && ctx.referencePrice > 0) {
      const deviation = Math.abs(ctx.quote.last - ctx.referencePrice) / ctx.referencePrice;
      if (deviation > limits.maxPriceDeviation) {
        fail(
          'price_deviation',
          'Quote deviates implausibly from the last trusted price.',
          `${(deviation * 100).toFixed(1)}%`,
          `${(limits.maxPriceDeviation * 100).toFixed(1)}%`,
        );
      }
    }
  }

  // ---- exposure ----------------------------------------------------------
  if (notional > limits.maxOrderNotional) {
    fail('max_order_notional', 'Order notional exceeds the single-order limit.', notional, limits.maxOrderNotional);
  }
  if (round(ctx.dailyNotionalUsed + notional, 2) > limits.maxDailyNotional) {
    fail(
      'max_daily_notional',
      'Order would exceed the rolling daily notional limit.',
      round(ctx.dailyNotionalUsed + notional, 2),
      limits.maxDailyNotional,
    );
  }

  // Projected position, so a series of small orders cannot creep past the cap.
  const signedDelta = intent.side === 'buy' ? intent.quantity : -intent.quantity;
  const projectedQty = ctx.position.quantity + signedDelta;
  const projectedNotional = round(Math.abs(projectedQty * (referencePx || ctx.position.averageCost)), 2);
  if (projectedNotional > limits.maxPositionNotional) {
    fail(
      'max_position_notional',
      'Order would push the position past its concentration limit.',
      projectedNotional,
      limits.maxPositionNotional,
    );
  }

  // ---- fundamental invalidation breaker ----------------------------------
  // Spec §4: when a production line's structural integrity flags drop below
  // tolerance, the asset it produces stops being acquirable. This used to fire
  // only in "live mode", which meant it never fired at all. It is a property of
  // the asset, not of a deployment flag, so it is checked unconditionally —
  // acquiring more of a block whose render line has degraded is precisely the
  // move the breaker exists to prevent.
  if (intent.side === 'buy' && !ctx.spec.fundamentals_intact) {
    fail(
      'fundamentals_invalid',
      'Asset is flagged as fundamentally invalidated; acquisition is blocked. Liquidation is still permitted.',
      'invalid',
      'intact',
    );
  }

  return { allowed: violations.length === 0, violations, notional, quoteAgeMs: ageMs };
}

/**
 * Runtime-adjustable limits with a kill switch.
 *
 * Held in one place so `/api/risk/halt` and the trade path cannot disagree
 * about whether the system is halted.
 */
export class RiskController {
  private limits: RiskLimits;

  constructor(overrides: Partial<RiskLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...overrides };
  }

  get current(): RiskLimits {
    return { ...this.limits };
  }

  get isHalted(): boolean {
    return this.limits.halted;
  }

  halt(reason: string): RiskLimits {
    this.limits = { ...this.limits, halted: true, haltReason: reason };
    return this.current;
  }

  resume(): RiskLimits {
    this.limits = { ...this.limits, halted: false, haltReason: undefined };
    return this.current;
  }

  update(patch: Partial<RiskLimits>): RiskLimits {
    // Halting is done through halt()/resume() so the reason is always set.
    const { halted, haltReason, ...safe } = patch;
    this.limits = { ...this.limits, ...safe };
    return this.current;
  }

  assess(intent: OrderIntent, ctx: RiskContext): RiskVerdict {
    return assess(intent, this.limits, ctx);
  }
}

/** Build limits from the environment, with the defaults above as fallbacks. */
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<RiskLimits> {
  const num = (key: string) => {
    const raw = env[key];
    if (raw === undefined || raw === '') return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const out: Partial<RiskLimits> = {};
  const maxOrder = num('RISK_MAX_ORDER_NOTIONAL');
  const maxDaily = num('RISK_MAX_DAILY_NOTIONAL');
  const maxPosition = num('RISK_MAX_POSITION_NOTIONAL');
  const maxAge = num('RISK_MAX_QUOTE_AGE_MS');
  const maxDev = num('RISK_MAX_PRICE_DEVIATION');

  if (maxOrder !== undefined) out.maxOrderNotional = maxOrder;
  if (maxDaily !== undefined) out.maxDailyNotional = maxDaily;
  if (maxPosition !== undefined) out.maxPositionNotional = maxPosition;
  if (maxAge !== undefined) out.maxQuoteAgeMs = maxAge;
  if (maxDev !== undefined) out.maxPriceDeviation = maxDev;
  // Start halted if asked — useful for a cautious first boot in a new environment.
  if (env.RISK_START_HALTED === 'true') {
    out.halted = true;
    out.haltReason = 'Started halted by RISK_START_HALTED.';
  }

  return out;
}
