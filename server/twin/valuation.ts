/**
 * Boardroom arithmetic, derived from the graph.
 *
 * Everything here is a pure function of the twin. Nothing is stored, nothing is
 * cached, and no number appears that cannot be traced to a field in a vault
 * file — which is the property that makes the boardroom worth looking at. The
 * previous version of this screen displayed constants.
 *
 * THE MANDATE, IN THE SPECIFICATION'S OWN TERMS (§4)
 * --------------------------------------------------
 *   Strike floor   = acquisition × 1.30      sell on any bid at or above this
 *   Stop floor     = acquisition × 0.85      liquidate at or below this
 *   Net yield      = bid × (1 − sellFee) − acquisition × (1 + buyFee)
 *   Exit condition = net yield > 0           enforced, not advisory
 *
 * The distinction that matters, and that a naive reading of the spec misses:
 * a bid can clear the 30% strike trigger and still lose money once both fee
 * legs are paid. `HOLD_REJECT_OFFER` in the specification's own pseudocode is
 * that case. It is modelled here as `strikeTriggered && !netPositive`, and it
 * is surfaced in the UI, because an operator watching a "target achieved"
 * badge on a losing trade would rightly stop trusting the screen.
 */

import { round } from '../assets/types';
import type { AssetClass, InventoryBlock, SupplyGraph, WarehouseNode } from './types';

/** Fee rates per asset class. Sourced from the asset table, passed in rather than imported. */
export type FeeTable = Record<string, { buy: number; sell: number }>;

export interface MandatePolicy {
  /** Fraction above acquisition at which a bid must be struck. Spec: 0.30. */
  profitTargetPct: number;
  /** Fraction below acquisition at which the position must be liquidated. Spec: 0.15. */
  stopLossPct: number;
}

export const SPEC_MANDATE: MandatePolicy = { profitTargetPct: 0.3, stopLossPct: 0.15 };

export interface BlockValuation {
  warehouseSlug: string;
  warehouseName: string;
  nodeId: string;
  assetClass: AssetClass;
  quantity: number;
  acquisitionCostPerUnit: number;
  marketBidFloor: number;

  /** acquisition × 1.30 */
  strikeFloor: number;
  /** acquisition × 0.85 */
  stopFloor: number;

  /** quantity × bid. What the holding is worth right now. */
  markToMarket: number;
  /** quantity × acquisition. What it cost. */
  costBasis: number;
  /** Per unit, after both fee legs. The number the mandate actually gates on. */
  netYieldPerUnit: number;
  netYieldTotal: number;

  strikeTriggered: boolean;
  stopBreached: boolean;
  /** Clears the 30% trigger but loses money net of fees. The trap in the spec. */
  strikeUneconomic: boolean;

  /** What the mandate says to do, in one word. */
  verdict: 'SELL_STOP_LOSS' | 'SELL_STRIKE' | 'HOLD_UNECONOMIC' | 'HOLD';
  reason: string;

  storageTb: number;
}

export interface LineSummary {
  factorySlug: string;
  factoryName: string;
  lineId: string;
  produces: AssetClass;
  throughput: number;
  throughputUnit: string;
  marginalCostPerUnit: number;
  status: string;
}

export interface WarehouseSummary {
  slug: string;
  name: string;
  nodeId: string;
  storageCapacityTb: number;
  storageUsedTb: number;
  /** null when any block is missing `block_size_tb` — an unknown, not a zero. */
  utilisation: number | null;
  markToMarket: number;
}

export interface EcosystemValuation {
  /** Σ quantity × bid across every warehouse. */
  totalValuation: number;
  totalCostBasis: number;
  /** Σ net yield if every holding were sold now, after both fee legs. */
  unrealisedNetYield: number;

  blocks: BlockValuation[];
  warehouses: WarehouseSummary[];
  lines: LineSummary[];

  strikesTriggered: number;
  stopsBreached: number;
  uneconomicStrikes: number;

  /** Lines declared but not operational, by asset class. Drives the breaker. */
  degradedAssetClasses: AssetClass[];

  /** null when the vault does not carry enough data to compute it honestly. */
  computeUtilisation: number | null;

  errors: number;
  warnings: number;
}

const feesFor = (fees: FeeTable, assetClass: AssetClass) =>
  fees[assetClass] ?? { buy: 0, sell: 0 };

export function valueBlock(
  warehouse: WarehouseNode,
  block: InventoryBlock,
  fees: FeeTable,
  policy: MandatePolicy = SPEC_MANDATE,
): BlockValuation {
  const { buy, sell } = feesFor(fees, block.assetClass);
  const acquisition = block.acquisitionCostPerUnit;
  const bid = block.marketBidFloor;

  const strikeFloor = round(acquisition * (1 + policy.profitTargetPct), 4);
  const stopFloor = round(acquisition * (1 - policy.stopLossPct), 4);

  // Both legs. Selling at 130% of a price you paid 2% of fee on, and paying
  // 2.5% to sell, is not a 30% gain — and the difference is what decides
  // whether the trade is allowed at all.
  const netYieldPerUnit = round(bid * (1 - sell) - acquisition * (1 + buy), 6);
  const netYieldTotal = round(netYieldPerUnit * block.quantity, 2);

  const strikeTriggered = bid >= strikeFloor;
  const stopBreached = bid <= stopFloor;
  const netPositive = netYieldPerUnit > 0;
  const strikeUneconomic = strikeTriggered && !netPositive;

  let verdict: BlockValuation['verdict'];
  let reason: string;

  if (stopBreached) {
    // The stop is a risk exit, not a profit one. It fires even at a loss —
    // that is what a stop is — so it is deliberately checked before net yield.
    verdict = 'SELL_STOP_LOSS';
    reason = `Bid ${bid.toFixed(2)} is at or below the ${(policy.stopLossPct * 100).toFixed(0)}% stop floor of ${stopFloor.toFixed(2)}.`;
  } else if (strikeUneconomic) {
    verdict = 'HOLD_UNECONOMIC';
    reason = `Bid ${bid.toFixed(2)} clears the strike floor of ${strikeFloor.toFixed(2)}, but both fee legs leave ${netYieldPerUnit.toFixed(4)} per unit. Refused.`;
  } else if (strikeTriggered) {
    verdict = 'SELL_STRIKE';
    reason = `Bid ${bid.toFixed(2)} is at or above the ${(policy.profitTargetPct * 100).toFixed(0)}% strike floor of ${strikeFloor.toFixed(2)}, net ${netYieldPerUnit.toFixed(4)} per unit.`;
  } else {
    verdict = 'HOLD';
    reason = `Bid ${bid.toFixed(2)} sits between the stop floor ${stopFloor.toFixed(2)} and the strike floor ${strikeFloor.toFixed(2)}.`;
  }

  return {
    warehouseSlug: warehouse.slug,
    warehouseName: warehouse.name,
    nodeId: warehouse.nodeId,
    assetClass: block.assetClass,
    quantity: block.quantity,
    acquisitionCostPerUnit: acquisition,
    marketBidFloor: bid,
    strikeFloor,
    stopFloor,
    markToMarket: round(block.quantity * bid, 2),
    costBasis: round(block.quantity * acquisition, 2),
    netYieldPerUnit,
    netYieldTotal,
    strikeTriggered,
    stopBreached,
    strikeUneconomic,
    verdict,
    reason,
    storageTb: round(block.quantity * block.blockSizeTb, 3),
  };
}

export function valueEcosystem(
  graph: SupplyGraph,
  fees: FeeTable,
  policy: MandatePolicy = SPEC_MANDATE,
): EcosystemValuation {
  const blocks: BlockValuation[] = [];
  const warehouses: WarehouseSummary[] = [];

  for (const warehouse of graph.warehouses.values()) {
    const valued = warehouse.inventory.map((b) => valueBlock(warehouse, b, fees, policy));
    blocks.push(...valued);

    // Utilisation is null rather than wrong when a block size is missing. A
    // warehouse showing "0% full" because of an absent field reads as healthy,
    // which is the worst possible way to be missing data.
    const complete = warehouse.inventory.every((b) => b.blockSizeTb > 0);
    const usedTb = round(
      valued.reduce((n, v) => n + v.storageTb, 0),
      3,
    );

    warehouses.push({
      slug: warehouse.slug,
      name: warehouse.name,
      nodeId: warehouse.nodeId,
      storageCapacityTb: warehouse.storageCapacityTb,
      storageUsedTb: usedTb,
      utilisation:
        complete && warehouse.storageCapacityTb > 0
          ? round(usedTb / warehouse.storageCapacityTb, 4)
          : null,
      markToMarket: round(
        valued.reduce((n, v) => n + v.markToMarket, 0),
        2,
      ),
    });
  }

  const lines: LineSummary[] = [];
  for (const factory of graph.factories.values()) {
    for (const line of factory.lines) {
      lines.push({
        factorySlug: factory.slug,
        factoryName: factory.name,
        lineId: line.lineId,
        produces: line.produces,
        throughput: line.throughput,
        throughputUnit: line.throughputUnit,
        marginalCostPerUnit: line.marginalCostPerUnit,
        status: line.status,
      });
    }
  }

  const degraded = new Set<AssetClass>();
  const byClass = new Map<AssetClass, LineSummary[]>();
  for (const line of lines) {
    const bucket = byClass.get(line.produces) ?? [];
    bucket.push(line);
    byClass.set(line.produces, bucket);
  }
  for (const [assetClass, group] of byClass) {
    if (!group.some((l) => l.status === 'operational')) degraded.add(assetClass);
  }

  // Compute utilisation across the whole estate, weighted by declared capacity
  // rather than averaged across warehouses — a 5000 TB site and a 50 TB site
  // are not equal votes.
  const capacityTotal = warehouses.reduce(
    (n, w) => n + (w.utilisation === null ? 0 : w.storageCapacityTb),
    0,
  );
  const usedTotal = warehouses.reduce((n, w) => n + (w.utilisation === null ? 0 : w.storageUsedTb), 0);

  return {
    totalValuation: round(
      blocks.reduce((n, b) => n + b.markToMarket, 0),
      2,
    ),
    totalCostBasis: round(
      blocks.reduce((n, b) => n + b.costBasis, 0),
      2,
    ),
    unrealisedNetYield: round(
      blocks.reduce((n, b) => n + b.netYieldTotal, 0),
      2,
    ),
    blocks,
    warehouses,
    lines,
    strikesTriggered: blocks.filter((b) => b.verdict === 'SELL_STRIKE').length,
    stopsBreached: blocks.filter((b) => b.stopBreached).length,
    uneconomicStrikes: blocks.filter((b) => b.strikeUneconomic).length,
    degradedAssetClasses: [...degraded],
    computeUtilisation: capacityTotal > 0 ? round(usedTotal / capacityTotal, 4) : null,
    errors: graph.issues.filter((i) => i.severity === 'error').length,
    warnings: graph.issues.filter((i) => i.severity === 'warning').length,
  };
}
