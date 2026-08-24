/**
 * Asset runtime wiring.
 *
 * Builds the asset universe from the tenant's production and warehouse nodes,
 * runs boot-time reconciliation against the marketplace, and drives the
 * fill-ingestion loop.
 *
 * SCOPE, STATED ONCE SO IT IS NOT RE-LITIGATED LATER
 * --------------------------------------------------
 * The assets here are the media products this business manufactures — H.266
 * video blocks, synthesised audio streams, compute matrices — and the
 * marketplace is where bids for them arrive. This is NOT a financial exchange
 * integration and must not grow into one. There is exactly one marketplace
 * implementation, it is internal, and adding a broker adapter would be a
 * product decision, not a refactor.
 */

import type { Store, TenantId } from '../store/types';
import { ExecutionService, type ReconciliationReport } from './execution';
import { RiskController, limitsFromEnv } from './risk';
import { InternalBidFeed, InternalMarketplace, REALISTIC, CALM, type MarketBehaviour } from './internal-marketplace';
import type { Marketplace, BidFeed } from './marketplace';
import type { AssetSpec } from './types';

export * from './types';
export * from './marketplace';
export { ExecutionService } from './execution';
export { RiskController, assess, DEFAULT_LIMITS, type RiskLimits, type RiskVerdict } from './risk';
export { plan, DEFAULT_STRATEGY, netProceedsPerUnit, type StrategyPolicy } from './strategy';
export { derivePosition, applyFill, unrealisedPnl, reconciles, remainingQuantity } from './ledger';

/**
 * The asset universe.
 *
 * Derived from the tenant's own inventory: every asset class held in a
 * warehouse node, with the acquisition economics that node recorded. Nothing
 * outside this file constructs an `AssetSpec`, so the day these come from a
 * node-graph query instead of the asset table, only this function changes.
 */
export async function loadAssetSpecs(store: Store, tenantId: TenantId): Promise<Map<string, AssetSpec>> {
  const assets = await store.assets.list(tenantId);
  const map = new Map<string, AssetSpec>();

  for (const a of assets) {
    map.set(a.asset_id, {
      assetId: a.asset_id,
      name: a.name,
      asset_class: a.asset_class,
      // Media blocks are priced to the cent and sold whole; a fractional block
      // is not something a render line can produce.
      price_increment: 0.01,
      block_size: 1,
      min_blocks: 1,
      buy_fee_rate: a.buy_fees,
      sell_fee_rate: a.sell_fees,
      is_guaranteed: a.is_guaranteed,
      fundamentals_intact: a.fundamentals_intact,
      simulated: a.simulated ?? true,
    });
  }

  return map;
}

export interface AssetRuntime {
  tenantId: TenantId;
  execution: ExecutionService;
  risk: RiskController;
  marketplace: Marketplace;
  bids: BidFeed;
  assetSpecs: Map<string, AssetSpec>;
  lastReconciliation: ReconciliationReport | null;
  stop(): Promise<void>;
}

function behaviourFromEnv(): MarketBehaviour {
  return process.env.MARKET_BEHAVIOUR === 'calm' ? CALM : REALISTIC;
}

export async function startAssetRuntime(store: Store, tenantId: TenantId): Promise<AssetRuntime> {
  const assetSpecs = await loadAssetSpecs(store, tenantId);

  const seeds: Record<string, number> = {};
  for (const asset of await store.assets.list(tenantId)) {
    seeds[asset.asset_id] = asset.active_offer ?? asset.current_price;
  }

  // Each tenant gets its own bid series and its own marketplace instance. Two
  // tenants must never share a book, even internally, or the isolation tests
  // would pass for the wrong reason.
  const seedNum = Array.from(tenantId).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const bids = new InternalBidFeed(seeds, 8, seedNum);
  const marketplace = new InternalMarketplace(assetSpecs, (s) => bids.lastPrice(s), behaviourFromEnv(), seedNum);

  const execution = new ExecutionService(store, marketplace, bids, tenantId);
  const risk = new RiskController(limitsFromEnv());

  const runtime: AssetRuntime = {
    tenantId,
    execution,
    risk,
    marketplace,
    bids,
    assetSpecs,
    lastReconciliation: null,
    stop: async () => {
      clearInterval(fillTimer);
      clearInterval(tickTimer);
      await marketplace.close();
      await bids.close();
    },
  };

  // Boot-time reconciliation. Any disagreement between the ledger and the
  // marketplace is recorded to the audit chain, and a material one halts
  // settlement rather than guessing.
  try {
    const report = await execution.reconcile();
    runtime.lastReconciliation = report;

    if (report.fillsReplayed > 0 || report.ordersUpdated > 0 || report.discrepancies.length > 0) {
      await store.audit.append(tenantId, {
        event: 'assets.reconciled',
        actorId: null,
        actorName: 'system',
        actorRole: null,
        subject: marketplace.id,
        outcome: report.discrepancies.length > 0 ? 'refused' : 'info',
        detail: { ...report },
      });
    }

    if (report.discrepancies.length > 0) {
      risk.halt(
        `Reconciliation found ${report.discrepancies.length} discrepancy(ies) against the marketplace. Settlement halted pending review.`,
      );
      console.error('[assets] HALTED — reconciliation discrepancies:', report.discrepancies);
    }
  } catch (err) {
    risk.halt('Boot reconciliation failed; settlement halted until the marketplace can be reached.');
    console.error('[assets] reconciliation failed:', err);
  }

  const tickTimer = setInterval(() => {
    void marketplace.tick().catch(() => undefined);
  }, 1500);
  tickTimer.unref?.();

  const fillTimer = setInterval(() => {
    void execution.ingestFills().catch((err) => console.error('[assets] fill ingestion failed:', err));
  }, 2000);
  fillTimer.unref?.();

  return runtime;
}
