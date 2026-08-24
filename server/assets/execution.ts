/**
 * Execution service — the bridge between a decision and a venue.
 *
 * Responsibilities, in the order they matter:
 *
 *  1. **Persist intent before acting.** The order row is written before the
 *     venue is called. A crash or timeout after that point leaves a durable
 *     record to reconcile against instead of an unanswerable question.
 *  2. **Resolve uncertainty by asking, not by retrying.** When `place()` throws,
 *     the order may or may not exist at the venue. We query by `clientOrderId`
 *     rather than resubmitting, because a blind retry is how one intent becomes
 *     two positions.
 *  3. **Converge on restart.** `reconcile()` pulls open orders and replays fills
 *     from a stored cursor, so the ledger recovers from a mid-flight crash.
 *
 * Positions are always derived from fills. Nothing here writes a position.
 */

import crypto from 'crypto';
import type { Store, TenantId } from '../store/types';
import { applyFillsToOrder, derivePosition, remainingQuantity } from './ledger';
import { isTerminal, round, type Fill, type Order, type OrderIntent, type Position } from './types';
import type { Marketplace, BidFeed, MarketplaceFill } from './marketplace';
import { MarketplaceError } from './marketplace';

const FILL_CURSOR_KEY = 'venue.fill_cursor';

export interface PlaceResult {
  order: Order;
  /** True when the venue recognised this clientOrderId as one it already had. */
  deduplicated: boolean;
  /** Set when the venue call failed and the order state had to be resolved by query. */
  resolvedAfterFailure?: string;
}

export interface ReconciliationReport {
  ranAt: string;
  openOrdersAtVenue: number;
  openOrdersLocally: number;
  fillsReplayed: number;
  ordersUpdated: number;
  /** Anything the two sides disagreed about. Non-empty means investigate. */
  discrepancies: { clientOrderId: string; issue: string; local: string; venue: string }[];
}

/**
 * One service per tenant.
 *
 * The tenant is fixed at construction rather than passed per call. Two reasons:
 * it makes a cross-tenant call impossible to express, and it matches the
 * deployment reality — each tenant has its OWN venue credentials. Commingling
 * several customers' orders through one exchange account is not a scaling
 * detail, it is a regulatory and correctness failure: the venue's fill stream
 * would mix customers together with no reliable way to attribute them back.
 */
export class ExecutionService {
  constructor(
    private store: Store,
    private marketplace: Marketplace,
    private bids: BidFeed,
    private tenantId: TenantId,
  ) {}

  /** Deterministic, unique, and ours — the idempotency key for the whole flow. */
  static newClientOrderId(): string {
    return `coid-${crypto.randomUUID()}`;
  }

  async place(
    intent: OrderIntent,
    actor: { id: string | null; name: string | null },
  ): Promise<PlaceResult> {
    const now = new Date().toISOString();

    const draft: Order = {
      ...intent,
      id: `ord-${crypto.randomUUID()}`,
      status: 'pending',
      marketplaceOrderId: null,
      filledQuantity: 0,
      averageFillPrice: 0,
      feesPaid: 0,
      createdAt: now,
      updatedAt: now,
      actorId: actor.id,
      actorName: actor.name,
      marketplace: this.marketplace.id,
      mode: 'internal',
      rejectReason: null,
    };

    // Step 1: durable intent. If everything after this fails, reconciliation
    // still knows an order with this id may exist at the venue.
    const { order: persisted, created } = await this.store.orders.create(this.tenantId, draft);
    if (!created) {
      // Same clientOrderId submitted twice — return what we already have rather
      // than placing a second order.
      return { order: persisted, deduplicated: true };
    }

    // Step 2: talk to the venue.
    try {
      const placed = await this.marketplace.place(intent);
      const updated = await this.store.orders.update(this.tenantId, intent.clientOrderId, {
        status: placed.status,
        marketplaceOrderId: placed.marketplaceOrderId,
        rejectReason: placed.rejectReason ?? null,
      });
      return { order: updated ?? persisted, deduplicated: placed.deduplicated };
    } catch (err) {
      // Step 3: the hard case. The call failed, but the order may still be live.
      // Ask the venue what it thinks; do NOT resubmit.
      const message = err instanceof Error ? err.message : String(err);

      try {
        const marketplaceOrder = await this.marketplace.get(intent.clientOrderId);

        if (marketplaceOrder) {
          const updated = await this.store.orders.update(this.tenantId, intent.clientOrderId, {
            status: marketplaceOrder.status,
            marketplaceOrderId: marketplaceOrder.marketplaceOrderId,
            rejectReason: marketplaceOrder.rejectReason ?? null,
          });
          return {
            order: updated ?? persisted,
            deduplicated: false,
            resolvedAfterFailure: `Venue call failed (${message}) but the order was live; state recovered by query.`,
          };
        }

        // The venue has never heard of it, so nothing was placed.
        const updated = await this.store.orders.update(this.tenantId, intent.clientOrderId, {
          status: 'rejected',
          rejectReason: `Venue call failed and no order exists at the venue: ${message}`,
        });
        return {
          order: updated ?? persisted,
          deduplicated: false,
          resolvedAfterFailure: `Venue call failed (${message}); confirmed nothing was placed.`,
        };
      } catch (queryErr) {
        // We cannot reach the venue at all. Leave the order `pending` — the
        // one status that means "we do not know" — for reconciliation to
        // resolve later. Marking it rejected here would be a lie that could
        // orphan a live position.
        const detail = queryErr instanceof Error ? queryErr.message : String(queryErr);
        throw new MarketplaceError(
          `Order ${intent.clientOrderId} is in an unknown state: place failed (${message}) and the status query also failed (${detail}). It has been left pending for reconciliation.`,
          true,
          'unknown_state',
        );
      }
    }
  }

  async cancel(clientOrderId: string): Promise<Order | null> {
    const order = await this.store.orders.get(this.tenantId, clientOrderId);
    if (!order) return null;
    if (isTerminal(order.status)) return order;

    const result = await this.marketplace.cancel(clientOrderId);
    if (!result.ok) return order;

    return this.store.orders.update(this.tenantId, clientOrderId, { status: result.status });
  }

  /**
   * Pull fills from the venue and fold them into orders.
   *
   * Pull-based, not push-based, because streams drop. The cursor is persisted so
   * a restart resumes exactly where it left off, and `fills.record` is
   * idempotent on `marketplaceFillId` so overlap between the push and pull paths is
   * harmless rather than double-counted.
   */
  async ingestFills(): Promise<{ recorded: number; ordersUpdated: number }> {
    const cursor = await this.store.meta.get(this.tenantId, FILL_CURSOR_KEY);
    const { fills, cursor: nextCursor } = await this.marketplace.fillsSince(cursor);

    let recorded = 0;
    const touched = new Set<string>();

    for (const marketplaceFill of fills) {
      const fill = this.toFill(marketplaceFill);
      const { created } = await this.store.fills.record(this.tenantId, fill);
      if (created) recorded += 1;
      touched.add(fill.clientOrderId);
    }

    let ordersUpdated = 0;
    for (const clientOrderId of touched) {
      if (await this.refreshOrder(clientOrderId)) ordersUpdated += 1;
    }

    if (nextCursor !== cursor) await this.store.meta.set(this.tenantId, FILL_CURSOR_KEY, nextCursor);
    return { recorded, ordersUpdated };
  }

  /** Recompute an order's aggregates from its stored fills. */
  private async refreshOrder(clientOrderId: string): Promise<boolean> {
    const order = await this.store.orders.get(this.tenantId, clientOrderId);
    if (!order) return false;

    const fills = await this.store.fills.forOrder(this.tenantId, clientOrderId);
    const rolled = applyFillsToOrder(order, fills);

    if (
      rolled.status === order.status &&
      rolled.filledQuantity === order.filledQuantity &&
      rolled.feesPaid === order.feesPaid
    ) {
      return false;
    }

    await this.store.orders.update(this.tenantId, clientOrderId, {
      status: rolled.status,
      filledQuantity: rolled.filledQuantity,
      averageFillPrice: rolled.averageFillPrice,
      feesPaid: rolled.feesPaid,
    });
    return true;
  }

  private toFill(marketplaceFill: MarketplaceFill): Fill {
    return {
      ...marketplaceFill,
      id: `fill-${crypto.randomUUID()}`,
      receivedAt: new Date().toISOString(),
    };
  }

  /**
   * Reconcile local state against the venue.
   *
   * Run on boot and after any venue disconnect. Anything the two sides disagree
   * about is reported rather than silently patched: an unexplained divergence
   * between our book and the venue's is exactly the condition where guessing
   * makes things worse.
   */
  async reconcile(): Promise<ReconciliationReport> {
    const ranAt = new Date().toISOString();
    const discrepancies: ReconciliationReport['discrepancies'] = [];

    const { recorded } = await this.ingestFills();

    const marketplaceOpen = await this.marketplace.openOrders();
    const marketplaceByCoid = new Map(marketplaceOpen.map((o) => [o.clientOrderId, o]));
    const localOpen = await this.store.orders.open(this.tenantId);

    let ordersUpdated = 0;

    for (const local of localOpen) {
      const remote = marketplaceByCoid.get(local.clientOrderId);

      if (!remote) {
        // Not open at the venue. Either it completed while we were away, or it
        // never landed. Ask directly rather than assuming.
        const detail = await this.marketplace.get(local.clientOrderId);

        if (!detail) {
          // The venue has no record. A `pending` order simply never landed;
          // anything further along vanishing is a genuine discrepancy.
          if (local.status === 'pending') {
            await this.store.orders.update(this.tenantId, local.clientOrderId, {
              status: 'rejected',
              rejectReason: 'Not present at venue during reconciliation; order never landed.',
            });
            ordersUpdated += 1;
          } else {
            discrepancies.push({
              clientOrderId: local.clientOrderId,
              issue: 'Order is live locally but unknown to the venue.',
              local: local.status,
              venue: 'absent',
            });
          }
          continue;
        }

        if (detail.status !== local.status) {
          await this.store.orders.update(this.tenantId, local.clientOrderId, {
            status: detail.status,
            marketplaceOrderId: detail.marketplaceOrderId,
            rejectReason: detail.rejectReason ?? null,
          });
          ordersUpdated += 1;
        }
        continue;
      }

      // Still open at the venue: check the fill quantities agree.
      const localFilled = round(local.filledQuantity);
      const remoteFilled = round(remote.filledQuantity);

      if (Math.abs(localFilled - remoteFilled) > 1e-9) {
        discrepancies.push({
          clientOrderId: local.clientOrderId,
          issue: 'Filled quantity disagrees with the venue.',
          local: String(localFilled),
          venue: String(remoteFilled),
        });
      }

      if (local.status === 'pending') {
        await this.store.orders.update(this.tenantId, local.clientOrderId, {
          status: remote.status,
          marketplaceOrderId: remote.marketplaceOrderId,
        });
        ordersUpdated += 1;
      }
    }

    return {
      ranAt,
      openOrdersAtVenue: marketplaceOpen.length,
      openOrdersLocally: localOpen.length,
      fillsReplayed: recorded,
      ordersUpdated,
      discrepancies,
    };
  }

  async position(assetId: string): Promise<Position> {
    return derivePosition(assetId, await this.store.fills.forAsset(this.tenantId, assetId));
  }

  async positions(assetIds: string[]): Promise<Position[]> {
    return Promise.all(assetIds.map((s) => this.position(s)));
  }

  /** Notional traded in the trailing 24 hours, for the daily risk limit. */
  async dailyNotional(): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return this.store.fills.notionalSince(this.tenantId, since);
  }

  async workingOrders(): Promise<Order[]> {
    const open = await this.store.orders.open(this.tenantId);
    return open.filter((o) => remainingQuantity(o) > 0);
  }

  quote(assetId: string) {
    return this.bids.quote(assetId);
  }
}
