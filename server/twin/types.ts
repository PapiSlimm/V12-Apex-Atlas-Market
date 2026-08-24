/**
 * The digital twin, as a typed graph.
 *
 * WHY THIS EXISTS
 * ---------------
 * The specification is emphatic that the vault *is* the database: markdown
 * files with YAML frontmatter, readable by a human in Obsidian and by an agent
 * over MCP. Until now the application honoured half of that — it stored the
 * markdown, but the only structured data it could act on was a loose
 * `metrics` bag that a human editing the vault would never think to update.
 * Production line throughputs, marginal costs, warehouse capacities and
 * inventory blocks all existed *as text* and nowhere else.
 *
 * So the graph is parsed from the frontmatter rather than duplicated into its
 * own tables. One source of truth, the one the specification names. Editing
 * `Factory-Detroit-Main.md` in Obsidian changes what the boardroom computes,
 * which is the entire point of a digital twin and was previously not true.
 *
 * The cost of that choice is that a malformed vault is a runtime problem
 * rather than a compile-time one. `GraphIssue` is the answer: parsing never
 * throws, every defect is collected and reported, and the caller decides what
 * is fatal.
 */

export type NodeStatus = 'operational' | 'degraded' | 'offline';

/** The three asset classes the specification names. */
export type AssetClass = 'H266_Video_NFT' | 'AudioSynth_Stream' | 'Compute_Matrix';

/**
 * A production line's native throughput unit. Frames per second and hertz are
 * not interchangeable, and averaging them would produce a number that means
 * nothing — so the unit travels with the value.
 */
export type ThroughputUnit = 'fps' | 'hz' | 'slots';

export interface ProductionLine {
  lineId: string;
  /** Which asset class this line's output becomes. */
  produces: AssetClass;
  throughput: number;
  throughputUnit: ThroughputUnit;
  /** Cost to produce one unit of output, in dollars. */
  marginalCostPerUnit: number;
  status: NodeStatus;
}

export interface FactoryNode {
  kind: 'factory';
  /** Vault filename without extension, e.g. `Factory-Detroit-Main`. The link target. */
  slug: string;
  nodeId: string;
  name: string;
  parentHub: string | null;
  lines: ProductionLine[];
  downstreamWarehouses: string[];
  filePath: string;
}

/**
 * One holding in a warehouse. This is the row the whole profit mandate turns
 * on: quantity, what it cost, and what the market will currently pay.
 */
export interface InventoryBlock {
  assetClass: AssetClass;
  quantity: number;
  acquisitionCostPerUnit: number;
  marketBidFloor: number;
  /**
   * Storage footprint of a single block, in terabytes.
   *
   * NOT from the specification — added here because `storage_capacity_tb` is
   * unusable without it. A warehouse capacity of 5000 TB tells you nothing
   * about utilisation unless you know what a block weighs.
   */
  blockSizeTb: number;
}

export interface WarehouseNode {
  kind: 'warehouse';
  slug: string;
  nodeId: string;
  name: string;
  parentHub: string | null;
  upstreamFactories: string[];
  storageCapacityTb: number;
  inventory: InventoryBlock[];
  filePath: string;
}

export interface GeographicHub {
  kind: 'hub';
  slug: string;
  nodeId: string;
  name: string;
  coordinates: [number, number] | null;
  /** Local macro indicators. Energy cost feeds the true marginal cost of a frame. */
  energyCostPerMwh: number | null;
  labourMultiplier: number | null;
  regionalRiskIndex: number | null;
  filePath: string;
}

export interface GraphIssue {
  /** `error` means the graph is not trustworthy; `warning` means look at it. */
  severity: 'error' | 'warning';
  /** Vault slug the problem belongs to, so the message points at a file. */
  slug: string;
  code: string;
  message: string;
}

export interface SupplyGraph {
  hubs: Map<string, GeographicHub>;
  factories: Map<string, FactoryNode>;
  warehouses: Map<string, WarehouseNode>;
  issues: GraphIssue[];
}

export const emptyGraph = (): SupplyGraph => ({
  hubs: new Map(),
  factories: new Map(),
  warehouses: new Map(),
  issues: [],
});

export const ASSET_CLASSES: readonly AssetClass[] = [
  'H266_Video_NFT',
  'AudioSynth_Stream',
  'Compute_Matrix',
];

export const isAssetClass = (v: unknown): v is AssetClass =>
  typeof v === 'string' && (ASSET_CLASSES as readonly string[]).includes(v);
