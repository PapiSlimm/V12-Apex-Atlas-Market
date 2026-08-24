/**
 * Execution domain model.
 *
 * The previous model was "an asset row with a quantity"; executing meant
 * setting that quantity to zero. It could not express an instruction that is
 * in flight, a partial execution, or a rejection — which is most of what an
 * execution system exists to track.
 *
 * Here, a **position is never stored as truth**. It is derived from an ordered
 * sequence of fills. Storing a position and also storing the fills that produced
 * it means two sources of truth that will disagree, and the disagreement always
 * surfaces as money that does not add up.
 *
 * MONEY REPRESENTATION
 * --------------------
 * All prices and quantities are plain JS numbers, and that is a deliberate,
 * bounded choice: the quantities here are small enough that float64 is exact to
 * well past cent precision, every comparison that gates a trade rounds first
 * (see `round`), and the reconciliation test asserts the books balance to
 * 1e-6 across randomised fill sequences. If this ever carries real settlement
 * volume, move to integer minor units — the seam is `round()` and the fee
 * arithmetic in `ledger.ts`, both in one place for that reason.
 */

export type AssetClass = 'H266_Video_NFT' | 'AudioSynth_Stream' | 'Compute_Matrix';

export type Side = 'buy' | 'sell';

export type OrderType = 'market' | 'limit';

/** Good-til-cancelled, immediate-or-cancel, fill-or-kill. */
export type TimeInForce = 'gtc' | 'ioc' | 'fok';

export type OrderStatus =
  | 'pending' // persisted locally, not yet acknowledged by the venue
  | 'working' // live at the venue, no fills yet
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'expired';

/** Statuses from which no further transition is possible. */
export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'filled',
  'cancelled',
  'rejected',
  'expired',
]);

export const isTerminal = (status: OrderStatus): boolean => TERMINAL_STATUSES.has(status);

/**
 * Legal state transitions. Enforced rather than documented, because an order
 * that goes from `filled` back to `working` is a bug that silently duplicates
 * inventory, and the only reliable moment to catch it is at the transition.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending: ['working', 'partially_filled', 'filled', 'rejected', 'cancelled', 'expired'],
  working: ['partially_filled', 'filled', 'cancelled', 'expired', 'rejected'],
  partially_filled: ['partially_filled', 'filled', 'cancelled', 'expired'],
  filled: [],
  cancelled: [],
  rejected: [],
  expired: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export interface AssetSpec {
  assetId: string;
  name: string;
  asset_class: AssetClass;
  /** Minimum price increment. Prices are rounded to this before leaving the system. */
  price_increment: number;
  /** Minimum tradeable increment of quantity. */
  block_size: number;
  /** Smallest order the venue will accept. */
  min_blocks: number;
  buy_fee_rate: number;
  sell_fee_rate: number;
  /** Whether the instrument qualifies for automatic strike execution. */
  is_guaranteed: boolean;
  fundamentals_intact: boolean;
  simulated: boolean;
}

export interface Quote {
  assetId: string;
  bid: number;
  ask: number;
  /** Last traded price. */
  last: number;
  /** When the venue says this quote was generated. */
  timestamp: string;
  /** When we received it. Both are kept because they will disagree. */
  receivedAt: string;
  source: string;
  simulated: boolean;
}

export const midPrice = (q: Quote): number => (q.bid + q.ask) / 2;

/** Age in milliseconds, measured on our clock to avoid venue clock skew. */
export function quoteAgeMs(q: Quote, now: number = Date.now()): number {
  return Math.max(0, now - Date.parse(q.receivedAt));
}

/**
 * What we intend to do. Created and persisted BEFORE the venue is called, so a
 * timeout is recoverable: `clientOrderId` is the idempotency key that lets us
 * ask "did this land?" instead of retrying blindly and risking a double.
 */
export interface OrderIntent {
  clientOrderId: string;
  assetId: string;
  side: Side;
  quantity: number;
  type: OrderType;
  /** Required for limit orders; ignored for market orders. */
  limitPrice?: number;
  timeInForce: TimeInForce;
  /** Free-form provenance: which rule or operator produced this. */
  reason: string;
}

export interface Order extends OrderIntent {
  id: string;
  status: OrderStatus;
  /** Venue's own identifier, once known. */
  marketplaceOrderId: string | null;
  filledQuantity: number;
  /** Quantity-weighted average fill price. */
  averageFillPrice: number;
  feesPaid: number;
  createdAt: string;
  updatedAt: string;
  actorId: string | null;
  actorName: string | null;
  /** Which marketplace matched it. */
  marketplace: string;
  /**
   * Which market this order settled in.
   *
   *   'internal' — one organisation trading its own inventory between its own
   *                desks. Always available.
   *   'galaxy'   — a multi-party market: distinct companies buying, selling and
   *                trading goods, services and resources with each other. The
   *                counterparty is another admitted participant, not a desk.
   *
   * WHAT IS STILL EXCLUDED, AND WHY IT IS NOT THE SAME THING
   * -------------------------------------------------------
   * There is no securities or crypto venue mode, and there is not going to be.
   * A crypto-exchange adapter was deleted from this codebase early on and that
   * deletion was correct — Apex is not a financial-instruments broker.
   *
   * I then over-read that decision as "no external counterparties at all" and
   * pinned this field to the single value 'internal'. That was wrong, and it
   * quietly narrowed the product: a marketplace for goods and services BETWEEN
   * COMPANIES is the point of Apex, and it is a different thing from an equities
   * desk. Commerce between admitted participants is the product; trading
   * financial instruments is the excluded case.
   */
  mode: MarketMode;
  rejectReason?: string | null;
}

/**
 * The markets Apex will settle in. Adding a member here is a product decision
 * and should be argued for, not merged.
 */
export const MARKET_MODES = ['internal', 'galaxy'] as const;
export type MarketMode = (typeof MARKET_MODES)[number];

/**
 * Venue kinds that are permanently excluded, checked by name at pre-flight so a
 * securities or crypto adapter cannot arrive in a deploy unnoticed.
 */
export const EXCLUDED_VENUE_MARKERS = [
  'revolut', 'binance', 'coinbase', 'kraken', 'alpaca', 'ibkr', 'interactive-brokers',
  'exchange', 'brokerage', 'securities', 'equities', 'derivatives', 'futures', 'forex',
] as const;

export interface Fill {
  id: string;
  clientOrderId: string;
  marketplaceFillId: string;
  assetId: string;
  side: Side;
  quantity: number;
  price: number;
  fee: number;
  /** Venue's timestamp. */
  timestamp: string;
  /** Ours. Ordering uses venue sequence where available, not this. */
  receivedAt: string;
  /** Monotonic venue ordering token, when the venue provides one. */
  sequence: number | null;
}

export interface Position {
  assetId: string;
  /** Signed: negative means short. */
  quantity: number;
  /**
   * Weighted-average cost per unit, fees included. This is the number that
   * makes realised P&L correct across partial fills, and the number the old
   * `(current - acquisition) * quantity` calculation did not have.
   */
  averageCost: number;
  /** Cumulative realised P&L, net of fees on both legs. */
  realisedPnl: number;
  /** Cumulative fees paid, tracked separately for reconciliation. */
  feesPaid: number;
  /** Net cash effect of every fill: negative for buys, positive for sells. */
  cashFlow: number;
  fillCount: number;
  lastFillAt: string | null;
}

export const emptyPosition = (assetId: string): Position => ({
  assetId,
  quantity: 0,
  averageCost: 0,
  realisedPnl: 0,
  feesPaid: 0,
  cashFlow: 0,
  fillCount: 0,
  lastFillAt: null,
});

/** What the Hermes engine now emits instead of a verdict on the whole position. */
export interface ExecutionPlan {
  action: 'place_order' | 'hold';
  side?: Side;
  quantity?: number;
  type?: OrderType;
  limitPrice?: number;
  timeInForce?: TimeInForce;
  reason: string;
  /** True only when executing this plan cannot realise a loss. */
  zeroLossSatisfied: boolean;
  /** Everything the risk layer considered, for the audit record. */
  diagnostics: Record<string, number | string | boolean | null>;
}

export type Unsubscribe = () => void;

/**
 * Rounding helper. Every comparison that gates a trade goes through this, so
 * float dust never decides whether money moves.
 */
export function round(value: number, dp = 8): number {
  const factor = 10 ** dp;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Round a quantity down to a whole number of lots, never up. */
export function roundToLot(quantity: number, blockSize: number): number {
  if (blockSize <= 0) return round(quantity);
  return round(Math.floor(round(quantity / blockSize, 10)) * blockSize);
}

/** Round a price to the instrument's tick, in the direction that is conservative for `side`. */
export function roundToTick(price: number, priceIncrement: number, side: Side): number {
  if (priceIncrement <= 0) return round(price, 8);
  const ticks = price / priceIncrement;
  // A seller rounds its limit up (asks for no less); a buyer rounds down.
  const rounded = side === 'sell' ? Math.ceil(round(ticks, 10)) : Math.floor(round(ticks, 10));
  return round(rounded * priceIncrement);
}
