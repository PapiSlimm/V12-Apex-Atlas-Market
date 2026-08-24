/**
 * First-run vault contents. Types live in `store/types.ts`; this file is values.
 *
 * These files are the specification's own worked example (pp. 12–20), with two
 * deliberate additions:
 *
 *   - `block_size_tb` on every inventory block. `storage_capacity_tb` is
 *     unusable without it — 5,000 TB of capacity says nothing about how full a
 *     site is unless a block has a weight. With it, Warehouse Alpha computes to
 *     42% utilisation, which is the "Current Buffer Load: 42%" the
 *     specification's own boardroom mock-up displays. That figure was a
 *     constant in the mock-up; here it is derived.
 *   - `L3-ComputeMatrix`, so every asset class the system trades has a line
 *     that produces it. Without it the graph validator correctly reports that
 *     Warehouse Beta holds compute matrices nothing upstream can make.
 *
 * Everything else — node ids, throughputs, marginal costs, acquisition costs,
 * bid floors — is transcribed from the specification.
 */

import type { MarketAsset } from './hermes';
import type { TwinNode } from './store/types';

export const seedNodes = (): TwinNode[] => [
  {
    id: 'node-detroit',
    name: 'Detroit Grid Control',
    type: 'city_hub',
    node_id: 'DET-01',
    filePath: '10_Geographic_Hubs/City-Detroit.md',
    coordinates: [42.3314, -83.0458],
    connectedNodes: ['Factory-Detroit-Main', 'Warehouse-Midwest-Alpha', 'Warehouse-Midwest-Beta'],
    metrics: { energy_cost_mwh: 72.4, labor_multiplier: 1.04, status: 'operational' },
    content: `---
type: city_hub
node_id: DET-01
geo_coordinates: [42.3314, -83.0458]
local_regulations: US-MI-MFG-2026
regional_risk_index: 0.12
energy_cost_per_mwh: 72.40
labor_availability_multiplier: 1.04
active_tariffs: [0.05, 0.10]
---
# Detroit Grid Control

Connected Production: [[Factory-Detroit-Main]]

Connected Logistics: [[Warehouse-Midwest-Alpha]], [[Warehouse-Midwest-Beta]]

## Active Local Macro Indicators
- Energy Cost per MWh: $72.40
- Labor Availability Multiplier: 1.04
- Regional Risk Index: 0.12 (Low Risk)
`,
  },
  {
    id: 'node-factory-detroit',
    name: 'Factory Detroit Main',
    type: 'factory_node',
    node_id: 'DET-FAC-01',
    parent_hub: 'City-Detroit',
    filePath: '20_Production_Nodes/Factory-Detroit-Main.md',
    connectedNodes: ['Warehouse-Midwest-Alpha', 'Warehouse-Midwest-Beta'],
    metrics: { max_throughput_fps: 24000, marginal_cost_per_frame: 0.00012, status: 'operational' },
    content: `---
type: factory_node
node_id: DET-FAC-01
parent_hub: [[City-Detroit]]
multimedia_production_lines:
  - line_id: L1-VideoRender
    max_throughput_fps: 24000
    marginal_cost_per_frame: 0.00012
    status: operational
  - line_id: L2-AudioSynth
    max_throughput_hz: 192000
    marginal_cost_per_frame: 0.00004
    status: operational
  - line_id: L3-ComputeMatrix
    max_throughput_slots: 512
    marginal_cost_per_unit: 0.0180
    status: operational
downstream_warehouses: [ [[Warehouse-Midwest-Alpha]], [[Warehouse-Midwest-Beta]] ]
---
# Factory Detroit Main

Monitors internal raw compute matrices and transforms base raw data blocks
into functional multimedia product assets.

- Video Render Line L1: 24,000 FPS throughput
- Audio Synth Line L2: 192,000 Hz throughput
- Compute Matrix Line L3: 512 concurrent slots
`,
  },
  {
    id: 'node-warehouse-alpha',
    name: 'Warehouse Midwest Alpha',
    type: 'warehouse_node',
    node_id: 'MWH-ALPHA',
    parent_hub: 'City-Detroit',
    filePath: '30_Logistics_Nodes/Warehouse-Midwest-Alpha.md',
    connectedNodes: ['Factory-Detroit-Main'],
    metrics: { storage_capacity_tb: 5000, allocated_inventory: 1420, status: 'operational' },
    content: `---
type: warehouse_node
node_id: MWH-ALPHA
parent_hub: [[City-Detroit]]
upstream_factories: [ [[Factory-Detroit-Main]] ]
storage_capacity_tb: 5000
allocated_inventory_blocks:
  - asset_class: H266_Video_NFT
    quantity: 1420
    base_acquisition_cost_per_unit: 12.50
    current_market_bid_floor: 16.80
    block_size_tb: 1.48
---
# Warehouse Midwest Alpha

Maintains local cold-storage physical/digital buffer zones. Directly exposed
to real-time arbitrage endpoints.

- Current Asset: H266_Video_NFT (1,420 Blocks)
- Acquisition Cost: $12.50
- Target Strike Floor: $16.25 (30% trigger)
- Current Bid Floor: $16.80
`,
  },
  {
    id: 'node-warehouse-beta',
    name: 'Warehouse Midwest Beta',
    type: 'warehouse_node',
    node_id: 'MWH-BETA',
    parent_hub: 'City-Detroit',
    filePath: '30_Logistics_Nodes/Warehouse-Midwest-Beta.md',
    connectedNodes: ['Factory-Detroit-Main'],
    metrics: { storage_capacity_tb: 2000, allocated_inventory: 750, status: 'operational' },
    content: `---
type: warehouse_node
node_id: MWH-BETA
parent_hub: [[City-Detroit]]
upstream_factories: [ [[Factory-Detroit-Main]] ]
storage_capacity_tb: 2000
allocated_inventory_blocks:
  - asset_class: AudioSynth_Stream
    quantity: 500
    base_acquisition_cost_per_unit: 45.00
    current_market_bid_floor: 52.50
    block_size_tb: 0.80
  - asset_class: Compute_Matrix
    quantity: 250
    base_acquisition_cost_per_unit: 100.00
    current_market_bid_floor: 95.00
    block_size_tb: 2.00
---
# Warehouse Midwest Beta

Secondary buffer. Holds spatial audio buffers and reserved GPU cluster slots.

- AudioSynth_Stream: 500 blocks, acquired at $45.00, bid $52.50 (below the $58.50 strike floor)
- Compute_Matrix: 250 slots, acquired at $100.00, bid $95.00 (above the $85.00 stop floor)
`,
  },
];

export const seedAssets = (): MarketAsset[] => [
  {
    asset_id: 'AST-H266-001',
    name: 'H266 Render NFT Vector Array #104',
    asset_class: 'H266_Video_NFT',
    acquisition_price: 12.5,
    current_price: 16.8,
    buy_fees: 0.02,
    sell_fees: 0.025,
    is_guaranteed: true,
    fundamentals_intact: true,
    quantity: 1420,
    active_offer: 16.8,
    simulated: true,
  },
  {
    asset_id: 'AST-AUDIO-002',
    name: 'AudioSynth Spatial PCM Buffer Block',
    asset_class: 'AudioSynth_Stream',
    acquisition_price: 45.0,
    current_price: 52.5,
    buy_fees: 0.015,
    sell_fees: 0.02,
    is_guaranteed: true,
    fundamentals_intact: true,
    quantity: 500,
    active_offer: 58.5,
    simulated: true,
  },
  {
    asset_id: 'AST-COMPUTE-003',
    name: 'GPU Cloud Cluster Slot DET-FAC-01',
    asset_class: 'Compute_Matrix',
    acquisition_price: 100.0,
    current_price: 94.0,
    buy_fees: 0.03,
    sell_fees: 0.03,
    is_guaranteed: false,
    fundamentals_intact: true,
    quantity: 250,
    active_offer: 95.0,
    simulated: true,
  },
];
