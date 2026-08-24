/**
 * Venue and market-data contracts.
 *
 * Same pattern as `Store`: one interface, several implementations, one
 * conformance suite all of them must pass. Nothing above this layer knows
 * whether it is talking to a simulator or a broker.
 */

import type { Fill, OrderIntent, OrderStatus, Quote, Unsubscribe } from './types';

export interface BidFeed {
  readonly id: string;
  /** Point-in-time snapshot. */
  quote(assetId: string): Promise<Quote | null>;
  /** Push updates. Returns an unsubscribe handle. */
  subscribe(assetIds: string[], onQuote: (quote: Quote) => void): Unsubscribe;
  readonly capabilities: { streaming: boolean; depth: boolean };
  close(): Promise<void>;
}

/** The venue's view of an order — deliberately narrower than ours. */
export interface MarketplaceOrder {
  clientOrderId: string;
  marketplaceOrderId: string;
  assetId: string;
  status: OrderStatus;
  filledQuantity: number;
  remainingQuantity: number;
  rejectReason?: string | null;
}

export type MarketplaceFill = Omit<Fill, 'id' | 'receivedAt'>;

export interface PlacedOrder {
  marketplaceOrderId: string;
  status: OrderStatus;
  /** True when this call matched an order that already existed. */
  deduplicated: boolean;
  rejectReason?: string | null;
}

export interface CancelResult {
  ok: boolean;
  status: OrderStatus;
  reason?: string;
}

export class MarketplaceError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: string = 'venue_error',
  ) {
    super(message);
    this.name = 'MarketplaceError';
  }
}

export interface Marketplace {
  readonly id: string;
  

  /**
   * Place an order. MUST be idempotent on `clientOrderId`.
   *
   * This is the single most important guarantee in the interface. If `place()`
   * times out, the caller cannot know whether the order exists. Retrying a
   * non-idempotent place risks a double position; not retrying risks a silent
   * miss. Idempotency turns an unanswerable question into a safe repeat, and
   * `deduplicated: true` tells the caller which happened.
   */
  place(intent: OrderIntent): Promise<PlacedOrder>;

  cancel(clientOrderId: string): Promise<CancelResult>;

  get(clientOrderId: string): Promise<MarketplaceOrder | null>;

  /** Everything still live at the venue. The basis of boot-time reconciliation. */
  openOrders(): Promise<MarketplaceOrder[]>;

  /**
   * Pull-based fill catch-up. Streams drop; this is how we recover without
   * hoping we saw every message. The cursor is opaque and venue-defined.
   */
  fillsSince(cursor: string | null): Promise<{ fills: MarketplaceFill[]; cursor: string }>;

  /** Optional push channel. Callers must not depend on it for correctness. */
  onFill?(handler: (fill: MarketplaceFill) => void): Unsubscribe;

  close(): Promise<void>;
}
