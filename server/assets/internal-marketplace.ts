/**
 * The internal marketplace and its bid feed.
 *
 * Where bids for this business's media assets arrive, and where acquisition and
 * settlement instructions are matched. It is the only marketplace
 * implementation and is intended to stay that way — see the scope note in
 * `index.ts`.
 *
 * It is also deliberately unhelpful.
 *
 * A marketplace model that always settles instantly and completely tests almost
 * nothing: most execution bugs are handling bugs, not happy-path bugs. This one
 * partially fills, delays, rejects, and occasionally goes silent — so the
 * reconciliation and idempotency paths are exercised by the test suite rather
 * than by a customer discovering a stuck settlement.
 *
 * Everything random is driven by a seeded PRNG, so a failing scenario is
 * reproducible from its seed rather than being a flake.
 */

import crypto from 'crypto';
import {
  round,
  type AssetSpec,
  type OrderIntent,
  type OrderStatus,
  type Quote,
  type Unsubscribe,
} from './types';
import type {
  CancelResult,
  Marketplace,
  BidFeed,
  PlacedOrder,
  MarketplaceFill,
  MarketplaceOrder,
} from './marketplace';
import { MarketplaceError } from './marketplace';

/** Small deterministic PRNG (mulberry32). */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MarketBehaviour {
  /** Chance a place() call is rejected outright. */
  rejectRate: number;
  /** Chance a place() call throws as if the network dropped. */
  networkFailureRate: number;
  /** Chance an order fills in several pieces rather than one. */
  partialFillRate: number;
  /** Chance an order simply sits there, never filling. */
  stallRate: number;
  /** Simulated round-trip latency bounds, in milliseconds. */
  minLatencyMs: number;
  maxLatencyMs: number;
  /** Per-fill fee as a fraction of notional, when the instrument has none. */
  defaultFeeRate: number;
}

export const CALM: MarketBehaviour = {
  rejectRate: 0,
  networkFailureRate: 0,
  partialFillRate: 0,
  stallRate: 0,
  minLatencyMs: 0,
  maxLatencyMs: 0,
  defaultFeeRate: 0.001,
};

export const REALISTIC: MarketBehaviour = {
  rejectRate: 0.03,
  networkFailureRate: 0.02,
  partialFillRate: 0.45,
  stallRate: 0.05,
  minLatencyMs: 5,
  maxLatencyMs: 60,
  defaultFeeRate: 0.001,
};

interface SimOrder {
  intent: OrderIntent;
  marketplaceOrderId: string;
  status: OrderStatus;
  filled: number;
  remaining: number;
  rejectReason: string | null;
  /** Remaining fill tranches, applied on each tick. */
  schedule: number[];
  stalled: boolean;
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export class InternalMarketplace implements Marketplace {
  readonly id = 'internal';
  

  private orders = new Map<string, SimOrder>();
  private fills: MarketplaceFill[] = [];
  private fillHandlers = new Set<(fill: MarketplaceFill) => void>();
  private rand: () => number;
  private seq = 0;

  constructor(
    private assetSpecs: Map<string, AssetSpec>,
    private priceOf: (assetId: string) => number,
    private behaviour: MarketBehaviour = REALISTIC,
    seed = 1,
  ) {
    this.rand = mulberry32(seed);
  }

  /** Test hook: drive time forward deterministically instead of waiting. */
  async tick(): Promise<MarketplaceFill[]> {
    const produced: MarketplaceFill[] = [];

    for (const order of this.orders.values()) {
      if (order.stalled) continue;
      if (order.status !== 'working' && order.status !== 'partially_filled') continue;
      if (order.schedule.length === 0) continue;

      const quantity = order.schedule.shift()!;
      const instrument = this.assetSpecs.get(order.intent.assetId);
      const reference = this.priceOf(order.intent.assetId);

      // Fill inside the limit, never through it.
      let price = reference;
      if (order.intent.type === 'limit' && order.intent.limitPrice !== undefined) {
        price =
          order.intent.side === 'sell'
            ? Math.max(order.intent.limitPrice, reference)
            : Math.min(order.intent.limitPrice, reference);
      }

      const feeRate =
        order.intent.side === 'buy'
          ? (instrument?.buy_fee_rate ?? this.behaviour.defaultFeeRate)
          : (instrument?.sell_fee_rate ?? this.behaviour.defaultFeeRate);

      this.seq += 1;
      const fill: MarketplaceFill = {
        clientOrderId: order.intent.clientOrderId,
        marketplaceFillId: `simfill-${this.seq}`,
        assetId: order.intent.assetId,
        side: order.intent.side,
        quantity: round(quantity),
        price: round(price, 8),
        fee: round(price * quantity * feeRate, 8),
        timestamp: new Date().toISOString(),
        sequence: this.seq,
      };

      order.filled = round(order.filled + quantity);
      order.remaining = round(Math.max(0, order.intent.quantity - order.filled));
      order.status = order.remaining <= 1e-9 ? 'filled' : 'partially_filled';

      this.fills.push(fill);
      produced.push(fill);
      for (const handler of this.fillHandlers) handler(fill);
    }

    return produced;
  }

  /** Test hook: run ticks until nothing more will fill. */
  async drain(maxTicks = 50): Promise<MarketplaceFill[]> {
    const all: MarketplaceFill[] = [];
    for (let i = 0; i < maxTicks; i++) {
      const produced = await this.tick();
      if (produced.length === 0) break;
      all.push(...produced);
    }
    return all;
  }

  async place(intent: OrderIntent): Promise<PlacedOrder> {
    await sleep(this.latency());

    // Idempotency. A repeat of a clientOrderId we have seen returns the
    // original order rather than creating a second one — the behaviour the
    // caller relies on to recover from a timeout.
    const existing = this.orders.get(intent.clientOrderId);
    if (existing) {
      return {
        marketplaceOrderId: existing.marketplaceOrderId,
        status: existing.status,
        deduplicated: true,
        rejectReason: existing.rejectReason,
      };
    }

    // Network failure AFTER the order may have been accepted is the hard case:
    // the caller cannot tell whether it landed. We record it as working and
    // then throw, so a caller that retries or queries finds the real state —
    // exactly what a real venue timeout looks like.
    const failNetwork = this.rand() < this.behaviour.networkFailureRate;

    if (this.rand() < this.behaviour.rejectRate) {
      const rejected: SimOrder = {
        intent,
        marketplaceOrderId: `simord-${crypto.randomUUID()}`,
        status: 'rejected',
        filled: 0,
        remaining: intent.quantity,
        rejectReason: 'Simulated venue rejection.',
        schedule: [],
        stalled: false,
      };
      this.orders.set(intent.clientOrderId, rejected);
      return {
        marketplaceOrderId: rejected.marketplaceOrderId,
        status: 'rejected',
        deduplicated: false,
        rejectReason: rejected.rejectReason,
      };
    }

    const order: SimOrder = {
      intent,
      marketplaceOrderId: `simord-${crypto.randomUUID()}`,
      status: 'working',
      filled: 0,
      remaining: intent.quantity,
      rejectReason: null,
      schedule: this.buildSchedule(intent),
      stalled: this.rand() < this.behaviour.stallRate,
    };
    this.orders.set(intent.clientOrderId, order);

    if (failNetwork) {
      throw new MarketplaceError(
        'Simulated network failure after submission — order state is unknown to the caller.',
        true,
        'network',
      );
    }

    return { marketplaceOrderId: order.marketplaceOrderId, status: 'working', deduplicated: false };
  }

  async cancel(clientOrderId: string): Promise<CancelResult> {
    await sleep(this.latency());
    const order = this.orders.get(clientOrderId);
    if (!order) return { ok: false, status: 'rejected', reason: 'Unknown order.' };

    if (order.status === 'filled' || order.status === 'cancelled' || order.status === 'rejected') {
      return { ok: false, status: order.status, reason: `Order is already ${order.status}.` };
    }

    order.status = 'cancelled';
    order.schedule = [];
    return { ok: true, status: 'cancelled' };
  }

  async get(clientOrderId: string): Promise<MarketplaceOrder | null> {
    await sleep(this.latency());
    const order = this.orders.get(clientOrderId);
    return order ? this.toVenueOrder(order) : null;
  }

  async openOrders(): Promise<MarketplaceOrder[]> {
    await sleep(this.latency());
    return [...this.orders.values()]
      .filter((o) => o.status === 'working' || o.status === 'partially_filled')
      .map((o) => this.toVenueOrder(o));
  }

  async fillsSince(cursor: string | null): Promise<{ fills: MarketplaceFill[]; cursor: string }> {
    const from = cursor ? Number(cursor) : 0;
    const fills = this.fills.filter((f) => (f.sequence ?? 0) > from);
    const next = fills.length > 0 ? String(fills[fills.length - 1].sequence) : (cursor ?? '0');
    return { fills, cursor: next };
  }

  onFill(handler: (fill: MarketplaceFill) => void): Unsubscribe {
    this.fillHandlers.add(handler);
    return () => this.fillHandlers.delete(handler);
  }

  async close(): Promise<void> {
    this.fillHandlers.clear();
  }

  private toVenueOrder(order: SimOrder): MarketplaceOrder {
    return {
      clientOrderId: order.intent.clientOrderId,
      marketplaceOrderId: order.marketplaceOrderId,
      assetId: order.intent.assetId,
      status: order.status,
      filledQuantity: order.filled,
      remainingQuantity: order.remaining,
      rejectReason: order.rejectReason,
    };
  }

  private latency(): number {
    const { minLatencyMs, maxLatencyMs } = this.behaviour;
    if (maxLatencyMs <= 0) return 0;
    return minLatencyMs + this.rand() * (maxLatencyMs - minLatencyMs);
  }

  /** Split the order into one or more tranches, respecting lot size. */
  private buildSchedule(intent: OrderIntent): number[] {
    const lot = this.assetSpecs.get(intent.assetId)?.block_size ?? 0;
    if (this.rand() >= this.behaviour.partialFillRate) return [intent.quantity];

    const pieces = 2 + Math.floor(this.rand() * 3);
    const schedule: number[] = [];
    let left = intent.quantity;

    for (let i = 0; i < pieces - 1 && left > 0; i++) {
      let piece = left * (0.2 + this.rand() * 0.4);
      if (lot > 0) piece = Math.max(lot, Math.floor(piece / lot) * lot);
      piece = Math.min(piece, left);
      if (piece <= 0) break;
      schedule.push(round(piece));
      left = round(left - piece);
    }
    if (left > 0) schedule.push(round(left));

    return schedule;
  }
}

/**
 * Simulated market data: a bounded random walk around each instrument's
 * reference price, with a bid/ask spread.
 */
export class InternalBidFeed implements BidFeed {
  readonly id = 'internal-bids';
  readonly capabilities = { streaming: true, depth: false };

  private prices = new Map<string, number>();
  private timers = new Set<ReturnType<typeof setInterval>>();
  private rand: () => number;

  constructor(
    seeds: Record<string, number>,
    private spreadBps = 8,
    seed = 1,
  ) {
    this.rand = mulberry32(seed);
    for (const [assetId, price] of Object.entries(seeds)) this.prices.set(assetId, price);
  }

  lastPrice(assetId: string): number {
    return this.prices.get(assetId) ?? 0;
  }

  /** Test hook: move a price deterministically. */
  setPrice(assetId: string, price: number): void {
    this.prices.set(assetId, price);
  }

  private step(assetId: string): number {
    const current = this.prices.get(assetId) ?? 100;
    const drift = (this.rand() - 0.5) * current * 0.004;
    const next = Math.max(0.01, round(current + drift, 8));
    this.prices.set(assetId, next);
    return next;
  }

  private build(assetId: string, last: number): Quote {
    const halfSpread = (last * this.spreadBps) / 10_000 / 2;
    const now = new Date().toISOString();
    return {
      assetId,
      bid: round(last - halfSpread, 8),
      ask: round(last + halfSpread, 8),
      last,
      timestamp: now,
      receivedAt: now,
      source: this.id,
      simulated: true,
    };
  }

  async quote(assetId: string): Promise<Quote | null> {
    if (!this.prices.has(assetId)) return null;
    return this.build(assetId, this.step(assetId));
  }

  subscribe(assetIds: string[], onQuote: (quote: Quote) => void): Unsubscribe {
    const timer = setInterval(() => {
      for (const assetId of assetIds) {
        if (!this.prices.has(assetId)) continue;
        onQuote(this.build(assetId, this.step(assetId)));
      }
    }, 1000);
    timer.unref?.();
    this.timers.add(timer);

    return () => {
      clearInterval(timer);
      this.timers.delete(timer);
    };
  }

  async close(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
  }
}
