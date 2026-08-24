/**
 * V12 Apex Atlas: Macaron-v1 Agentic OS - Types
 */

export type UserRole = 'Executive' | 'Arbitrage Trader' | 'LoRABlender Engineer' | 'System Admin';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
}

export interface AuthResponse {
  user: User;
}

export interface SpecialistAllocation {
  chat: number;
  personal_agent: number;
  genui: number;
  coding: number;
}

export interface MoLRouteResult {
  query: string;
  selectedSpecialist: 'chat' | 'personal_agent' | 'genui' | 'coding';
  routingWeights: number[];
  allocationTrace: SpecialistAllocation;
  latencyMs: number;
  explanation: string;
}

export interface MarketAsset {
  asset_id: string;
  name: string;
  asset_class: 'H266_Video_NFT' | 'AudioSynth_Stream' | 'Compute_Matrix';
  acquisition_price: number;
  current_price: number;
  buy_fees: number;
  sell_fees: number;
  is_guaranteed: boolean;
  fundamentals_intact: boolean;
  quantity: number;
  active_offer?: number;
}

export type HermesAction =
  | 'SELL_IMMEDIATELY'
  | 'EXECUTE_SELL'
  | 'HOLD_REJECT_OFFER'
  | 'HOLD_CONTINUE_MONITOR';

export interface HermesEvaluation {
  action: HermesAction;
  reason: string;
  target_price?: number;
  /** Net proceeds per unit, after both the buy-side and sell-side fee legs. */
  realized_net_per_unit?: number;
  realized_net_total?: number;
  stop_loss_floor: number;
  target_strike: number;
  /** True only when executing right now cannot realise a loss. */
  zero_loss_satisfied: boolean;
}

export interface TradeRecord {
  id: string;
  asset_id: string;
  action: HermesAction;
  quantity: number;
  unit_price: number;
  realized_net_per_unit: number;
  realized_net_total: number;
  executedBy: string;
  timestamp: string;
  simulated: boolean;
}

export interface DigitalTwinNode {
  id: string;
  name: string;
  type: 'city_hub' | 'factory_node' | 'warehouse_node';
  node_id: string;
  parent_hub?: string;
  filePath: string;
  coordinates?: [number, number];
  content: string;
  connectedNodes: string[];
  metrics: {
    max_throughput_fps?: number;
    marginal_cost_per_frame?: number;
    energy_cost_mwh?: number;
    labor_multiplier?: number;
    storage_capacity_tb?: number;
    allocated_inventory?: number;
    status: 'operational' | 'degraded' | 'maintenance';
  };
}

export interface SynchronizerMetric {
  timestamp: string;
  latencyMs: number;
  targetNode: string;
  status: 'SYNCED' | 'REPLICATING' | 'ERROR';
  bidFloor: number;
  sha3Hash: string;
}

export interface ArtifactProps {
  code: string;
  propsData: any;
  title?: string;
}

export interface ToastMessage {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error' | 'sync';
  title: string;
  description?: string;
  timestamp: string;
  duration?: number;
}

export interface AgentChatMessage {
  id: string;
  sender: 'user' | 'agent' | 'system';
  specialist?: 'chat' | 'personal_agent' | 'genui' | 'coding';
  text: string;
  timestamp: string;
  artifact?: ArtifactProps;
  routingResult?: MoLRouteResult;
}
