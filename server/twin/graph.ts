/**
 * Building the supply graph from vault files, and checking it holds together.
 *
 * Two jobs, kept separate on purpose: `buildGraph` reads, `validate` judges.
 * Reading never fails — a vault with a broken file yields a graph missing that
 * node and an issue explaining why. Judging is where opinions live, and they
 * are all opinions the specification states.
 */

import type { TwinNode } from '../store/types';
import { link, links, num, parseFrontmatter, rows, str } from './frontmatter';
import {
  emptyGraph,
  isAssetClass,
  type AssetClass,
  type FactoryNode,
  type GeographicHub,
  type GraphIssue,
  type InventoryBlock,
  type NodeStatus,
  type ProductionLine,
  type SupplyGraph,
  type ThroughputUnit,
  type WarehouseNode,
} from './types';

/** `30_Logistics_Nodes/Warehouse-Midwest-Alpha.md` -> `Warehouse-Midwest-Alpha`. */
export function slugOf(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  return base.replace(/\.md$/i, '');
}

const STATUSES: NodeStatus[] = ['operational', 'degraded', 'offline'];

function statusOf(value: unknown, fallback: NodeStatus = 'operational'): NodeStatus {
  const s = str(value)?.toLowerCase();
  return s && (STATUSES as string[]).includes(s) ? (s as NodeStatus) : fallback;
}

/**
 * What a line produces.
 *
 * An explicit `produces:` wins. Failing that it is inferred from the
 * throughput unit, because the specification's own example files carry
 * `max_throughput_fps` and `max_throughput_hz` and nothing else — a video line
 * is measured in frames and an audio line in hertz. The inference is stated
 * here rather than assumed at three call sites.
 */
function lineOutput(row: Record<string, unknown>): {
  produces: AssetClass | null;
  throughput: number | null;
  unit: ThroughputUnit;
} {
  const explicit = str(row.produces);
  const fps = num(row.max_throughput_fps);
  const hz = num(row.max_throughput_hz);
  const slots = num(row.max_throughput_slots);

  if (fps !== null) {
    return { produces: isAssetClass(explicit) ? explicit : 'H266_Video_NFT', throughput: fps, unit: 'fps' };
  }
  if (hz !== null) {
    return { produces: isAssetClass(explicit) ? explicit : 'AudioSynth_Stream', throughput: hz, unit: 'hz' };
  }
  if (slots !== null) {
    return { produces: isAssetClass(explicit) ? explicit : 'Compute_Matrix', throughput: slots, unit: 'slots' };
  }
  return { produces: isAssetClass(explicit) ? explicit : null, throughput: null, unit: 'slots' };
}

export function buildGraph(nodes: TwinNode[]): SupplyGraph {
  const graph = emptyGraph();
  const issue = (severity: GraphIssue['severity'], slug: string, code: string, message: string) =>
    graph.issues.push({ severity, slug, code, message });

  for (const node of nodes) {
    const slug = slugOf(node.filePath);
    const { data, error } = parseFrontmatter(node.content ?? '');

    if (error) {
      issue('error', slug, 'frontmatter_invalid', `Frontmatter does not parse: ${error}`);
      continue;
    }

    // The stored type is authoritative; frontmatter `type:` is a cross-check,
    // because a file whose two type declarations disagree is a file someone
    // half-edited.
    const declared = str(data.type);
    if (declared && declared !== node.type) {
      issue(
        'warning',
        slug,
        'type_mismatch',
        `Stored type is "${node.type}" but frontmatter says "${declared}".`,
      );
    }

    const nodeId = str(data.node_id) ?? node.node_id;

    if (node.type === 'city_hub') {
      const coords = Array.isArray(data.geo_coordinates)
        ? data.geo_coordinates.map(num).filter((n): n is number => n !== null)
        : [];

      const hub: GeographicHub = {
        kind: 'hub',
        slug,
        nodeId,
        name: node.name,
        coordinates: coords.length === 2 ? [coords[0], coords[1]] : null,
        energyCostPerMwh: num(data.energy_cost_per_mwh),
        labourMultiplier: num(data.labor_availability_multiplier) ?? num(data.labour_multiplier),
        regionalRiskIndex: num(data.regional_risk_index),
        filePath: node.filePath,
      };
      graph.hubs.set(slug, hub);
      continue;
    }

    if (node.type === 'factory_node') {
      const lineRows = rows(data.multimedia_production_lines);
      const lines: ProductionLine[] = [];

      for (const row of lineRows) {
        const lineId = str(row.line_id);
        if (!lineId) {
          issue('warning', slug, 'line_unnamed', 'A production line has no `line_id` and was skipped.');
          continue;
        }

        const { produces, throughput, unit } = lineOutput(row);
        if (!produces || throughput === null) {
          issue(
            'warning',
            slug,
            'line_output_unknown',
            `Line ${lineId} declares no recognisable throughput, so what it produces is unknown.`,
          );
          continue;
        }

        lines.push({
          lineId,
          produces,
          throughput,
          throughputUnit: unit,
          marginalCostPerUnit: num(row.marginal_cost_per_frame) ?? num(row.marginal_cost_per_unit) ?? 0,
          status: statusOf(row.status),
        });
      }

      const factory: FactoryNode = {
        kind: 'factory',
        slug,
        nodeId,
        name: node.name,
        parentHub: link(data.parent_hub),
        lines,
        downstreamWarehouses: links(data.downstream_warehouses),
        filePath: node.filePath,
      };
      graph.factories.set(slug, factory);
      continue;
    }

    if (node.type === 'warehouse_node') {
      const inventory: InventoryBlock[] = [];

      for (const row of rows(data.allocated_inventory_blocks)) {
        const assetClass = str(row.asset_class);
        if (!isAssetClass(assetClass)) {
          issue(
            'warning',
            slug,
            'inventory_class_unknown',
            `Inventory block declares asset class "${assetClass ?? '(missing)'}", which is not one this system produces.`,
          );
          continue;
        }

        const quantity = num(row.quantity);
        const cost = num(row.base_acquisition_cost_per_unit);
        if (quantity === null || cost === null) {
          issue(
            'warning',
            slug,
            'inventory_incomplete',
            `Inventory block ${assetClass} is missing a quantity or an acquisition cost and was skipped.`,
          );
          continue;
        }

        inventory.push({
          assetClass,
          quantity,
          acquisitionCostPerUnit: cost,
          marketBidFloor: num(row.current_market_bid_floor) ?? 0,
          blockSizeTb: num(row.block_size_tb) ?? 0,
        });
      }

      const warehouse: WarehouseNode = {
        kind: 'warehouse',
        slug,
        nodeId,
        name: node.name,
        parentHub: link(data.parent_hub),
        upstreamFactories: links(data.upstream_factories),
        storageCapacityTb: num(data.storage_capacity_tb) ?? 0,
        inventory,
        filePath: node.filePath,
      };
      graph.warehouses.set(slug, warehouse);
    }
  }

  graph.issues.push(...validate(graph));
  return graph;
}

/**
 * Structural checks.
 *
 * Every one of these corresponds to a way the twin can quietly stop describing
 * reality. A dangling link means a node was renamed and something still points
 * at the old name; an asymmetric link means two files disagree about the
 * physical world; inventory with no producing line means the book holds
 * something the factory cannot make, which is either a data error or a
 * genuinely stranded asset. None of them are style opinions.
 */
export function validate(graph: SupplyGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const add = (severity: GraphIssue['severity'], slug: string, code: string, message: string) =>
    issues.push({ severity, slug, code, message });

  const hubExists = (s: string) => graph.hubs.has(s);

  for (const factory of graph.factories.values()) {
    if (!factory.parentHub) {
      add('warning', factory.slug, 'orphan_factory', 'Factory declares no parent hub.');
    } else if (!hubExists(factory.parentHub)) {
      add(
        'error',
        factory.slug,
        'dangling_hub',
        `Parent hub "${factory.parentHub}" does not exist in the vault.`,
      );
    }

    if (factory.lines.length === 0) {
      add('warning', factory.slug, 'no_lines', 'Factory declares no production lines.');
    }

    for (const target of factory.downstreamWarehouses) {
      const warehouse = graph.warehouses.get(target);
      if (!warehouse) {
        add(
          'error',
          factory.slug,
          'dangling_warehouse',
          `Downstream warehouse "${target}" does not exist in the vault.`,
        );
        continue;
      }
      if (!warehouse.upstreamFactories.includes(factory.slug)) {
        add(
          'warning',
          factory.slug,
          'asymmetric_link',
          `Factory lists ${target} downstream, but ${target} does not list this factory upstream.`,
        );
      }
    }
  }

  for (const warehouse of graph.warehouses.values()) {
    if (!warehouse.parentHub) {
      add('warning', warehouse.slug, 'orphan_warehouse', 'Warehouse declares no parent hub.');
    } else if (!hubExists(warehouse.parentHub)) {
      add(
        'error',
        warehouse.slug,
        'dangling_hub',
        `Parent hub "${warehouse.parentHub}" does not exist in the vault.`,
      );
    }

    for (const target of warehouse.upstreamFactories) {
      if (!graph.factories.has(target)) {
        add(
          'error',
          warehouse.slug,
          'dangling_factory',
          `Upstream factory "${target}" does not exist in the vault.`,
        );
      }
    }

    // Can anything upstream actually make what is sitting in here?
    const producible = new Set<AssetClass>();
    for (const slug of warehouse.upstreamFactories) {
      for (const line of graph.factories.get(slug)?.lines ?? []) producible.add(line.produces);
    }

    for (const block of warehouse.inventory) {
      if (block.quantity < 0) {
        add('error', warehouse.slug, 'negative_inventory', `${block.assetClass} has a negative quantity.`);
      }
      if (block.acquisitionCostPerUnit <= 0) {
        add(
          'warning',
          warehouse.slug,
          'zero_cost_basis',
          `${block.assetClass} has a non-positive acquisition cost, so profit on it cannot be computed.`,
        );
      }
      if (block.blockSizeTb <= 0 && warehouse.storageCapacityTb > 0) {
        add(
          'warning',
          warehouse.slug,
          'block_size_missing',
          `${block.assetClass} declares no block_size_tb, so storage utilisation cannot be computed.`,
        );
      }
      if (warehouse.upstreamFactories.length > 0 && !producible.has(block.assetClass)) {
        add(
          'warning',
          warehouse.slug,
          'unproducible_inventory',
          `Holds ${block.assetClass}, which no upstream factory has a line for.`,
        );
      }
    }

    const usedTb = warehouse.inventory.reduce((n, b) => n + b.quantity * b.blockSizeTb, 0);
    if (warehouse.storageCapacityTb > 0 && usedTb > warehouse.storageCapacityTb) {
      add(
        'error',
        warehouse.slug,
        'capacity_exceeded',
        `Allocated ${usedTb.toFixed(1)} TB against a declared capacity of ${warehouse.storageCapacityTb} TB.`,
      );
    }
  }

  return issues;
}

/**
 * Every operational line producing an asset class, across the whole graph.
 *
 * This is what makes the fundamental invalidation breaker mean something: an
 * asset class whose lines have all degraded is one the risk layer should stop
 * acquiring, and that fact now comes from the vault rather than a hardcoded
 * boolean.
 */
export function linesFor(graph: SupplyGraph, assetClass: AssetClass): ProductionLine[] {
  const out: ProductionLine[] = [];
  for (const factory of graph.factories.values()) {
    for (const line of factory.lines) if (line.produces === assetClass) out.push(line);
  }
  return out;
}

export function fundamentalsIntact(graph: SupplyGraph, assetClass: AssetClass): boolean {
  const lines = linesFor(graph, assetClass);
  // No line at all is not the same as a broken line. A graph that has never
  // been populated should not halt acquisition of everything; a graph that
  // declares lines and finds none of them operational should.
  if (lines.length === 0) return true;
  return lines.some((l) => l.status === 'operational');
}
