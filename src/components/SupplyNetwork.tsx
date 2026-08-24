import React, { useCallback, useEffect, useState } from 'react';
import { Boxes, Factory, Layers, MapPin, Warehouse } from 'lucide-react';
import { api } from '../lib/api';
import {
  Alert,
  Button,
  GlassPanel,
  KpiRow,
  Meter,
  PanelHeading,
  QuantumCard,
  StatTile,
  StatusChip,
  count,
  percent,
  roleFor,
  signedUsd,
  usd,
  type StatusRole,
} from '../design';

/*
 * The specification's boardroom (pp. 25–26) as a live panel.
 *
 * Every figure is derived from vault frontmatter on the server and recomputed
 * on each poll. The specification's own mock-up printed a fixed
 * "$12,482,900.50 TOTAL ECOSYSTEM VALUATION"; this is the sum of quantity × bid
 * across every warehouse, and it moves when you edit a markdown file.
 *
 * Built entirely from the design system — no bespoke panel, chip or metric box.
 * That is the point of having one.
 */

interface ProductionLine {
  lineId: string;
  produces: string;
  throughput: number;
  throughputUnit: string;
  marginalCostPerUnit: number;
  status: string;
}

interface Hub {
  slug: string;
  nodeId: string;
  name: string;
  coordinates: [number, number] | null;
  energyCostPerMwh: number | null;
  labourMultiplier: number | null;
  regionalRiskIndex: number | null;
}

interface FactoryNode {
  slug: string;
  nodeId: string;
  name: string;
  parentHub: string | null;
  lines: ProductionLine[];
  downstreamWarehouses: string[];
}

interface BlockValuation {
  warehouseSlug: string;
  warehouseName: string;
  nodeId: string;
  assetClass: string;
  quantity: number;
  acquisitionCostPerUnit: number;
  marketBidFloor: number;
  strikeFloor: number;
  stopFloor: number;
  markToMarket: number;
  netYieldPerUnit: number;
  netYieldTotal: number;
  verdict: 'SELL_STOP_LOSS' | 'SELL_STRIKE' | 'HOLD_UNECONOMIC' | 'HOLD';
  reason: string;
  storageTb: number;
}

interface WarehouseSummary {
  slug: string;
  name: string;
  nodeId: string;
  storageCapacityTb: number;
  storageUsedTb: number;
  utilisation: number | null;
  markToMarket: number;
}

interface GraphIssue {
  severity: 'error' | 'warning';
  slug: string;
  code: string;
  message: string;
}

interface TwinResponse {
  hubs: Hub[];
  factories: FactoryNode[];
  issues: GraphIssue[];
  mandate: { profitTargetPct: number; stopLossPct: number };
  valuation: {
    totalValuation: number;
    totalCostBasis: number;
    unrealisedNetYield: number;
    blocks: BlockValuation[];
    warehouses: WarehouseSummary[];
    strikesTriggered: number;
    stopsBreached: number;
    uneconomicStrikes: number;
    degradedAssetClasses: string[];
    computeUtilisation: number | null;
    errors: number;
    warnings: number;
  };
}

/** The mandate's four verdicts, as words a human reads rather than enum names. */
const VERDICT_LABEL: Record<BlockValuation['verdict'], string> = {
  SELL_STRIKE: 'Auto-strike',
  SELL_STOP_LOSS: 'Stop loss',
  HOLD_UNECONOMIC: 'Refused — fees',
  HOLD: 'Hold',
};

export const SupplyNetwork: React.FC = () => {
  const [twin, setTwin] = useState<TwinResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTwin(await api.get<TwinResponse>('/api/twin/graph'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not derive the supply graph.');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [load]);

  if (error) {
    return (
      <Alert role="critical" title="Supply graph unavailable." live="alert">
        {error}
      </Alert>
    );
  }

  if (!twin) {
    return (
      <GlassPanel>
        <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
          Deriving the supply graph from the vault…
        </p>
      </GlassPanel>
    );
  }

  const v = twin.valuation;
  const strikePct = (twin.mandate.profitTargetPct * 100).toFixed(0);
  const stopPct = (twin.mandate.stopLossPct * 100).toFixed(0);
  const issueRole: StatusRole = v.errors > 0 ? 'critical' : 'warning';

  return (
    <div className="space-y-4">
      <GlassPanel as="section" aria-label="Supply network">
        <PanelHeading
          icon={<Layers className="w-5 h-5" style={{ color: 'var(--series-1)' }} />}
          title="Supply network"
          subtitle="Derived from the vault on every poll — hubs, production lines and warehouse inventory."
          actions={
            <span className="text-[10px]" style={{ color: 'var(--ink-muted)' }}>
              {twin.hubs.length} hub · {twin.factories.length} factory · {v.warehouses.length} warehouse
            </span>
          }
        />

        <KpiRow>
          <StatTile
            label="Ecosystem valuation"
            value={v.totalValuation}
            currency
            hint={`cost basis ${usd(v.totalCostBasis)}`}
          />
          <StatTile
            label="Unrealised, both fee legs"
            value={signedUsd(v.unrealisedNetYield)}
            role={v.unrealisedNetYield >= 0 ? 'good' : 'critical'}
            hint="if every holding sold now"
          />
          <StatTile
            label="Buffer load"
            value={percent(v.computeUtilisation)}
            hint={v.computeUtilisation === null ? 'block sizes missing' : 'of declared capacity'}
          />
          <StatTile
            label="Mandate triggers"
            value={`${v.strikesTriggered} / ${v.stopsBreached} / ${v.uneconomicStrikes}`}
            hint="strike / stop / refused"
          />
        </KpiRow>
      </GlassPanel>

      {twin.issues.length > 0 && (
        <Alert
          role={issueRole}
          title={`Vault consistency: ${v.errors} error${v.errors === 1 ? '' : 's'}, ${v.warnings} warning${
            v.warnings === 1 ? '' : 's'
          }.`}
        >
          <ul className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
            {twin.issues.map((issue, i) => (
              <li key={`${issue.slug}-${issue.code}-${i}`} className="flex gap-2">
                <span className="text-[10px] opacity-70 shrink-0">{issue.slug}</span>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </Alert>
      )}

      {v.degradedAssetClasses.length > 0 && (
        <Alert role="critical" title="Fundamental invalidation breaker armed." live="alert">
          No operational line currently produces {v.degradedAssetClasses.join(', ')}. Acquisition of those
          classes is refused; liquidation stays permitted.
        </Alert>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* ------------------------------------------------------- production */}
        <GlassPanel as="section" aria-label="Production">
          <PanelHeading
            icon={<Factory className="w-4 h-4" style={{ color: 'var(--series-1)' }} />}
            title="Production"
          />

          <div className="space-y-3">
            {twin.hubs.map((hub) => (
              <div
                key={hub.slug}
                className="rounded-[var(--radius-md)] border p-3"
                style={{ background: 'var(--surface-2)', borderColor: 'var(--line-subtle)' }}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span
                    className="text-[11px] font-semibold flex items-center gap-1.5"
                    style={{ color: 'var(--ink-primary)' }}
                  >
                    <MapPin className="w-3.5 h-3.5" style={{ color: 'var(--series-1)' }} aria-hidden="true" />
                    {hub.name}
                  </span>
                  <span className="text-[10px] tabular" style={{ color: 'var(--ink-muted)' }}>
                    {hub.nodeId}
                  </span>
                </div>
                <div className="text-[10px] mb-2" style={{ color: 'var(--ink-muted)' }}>
                  {hub.energyCostPerMwh !== null && <>energy {usd(hub.energyCostPerMwh)}/MWh · </>}
                  {hub.labourMultiplier !== null && <>labour ×{hub.labourMultiplier} · </>}
                  {hub.regionalRiskIndex !== null && <>risk {hub.regionalRiskIndex}</>}
                </div>

                {twin.factories
                  .filter((f) => f.parentHub === hub.slug)
                  .map((factory) => (
                    <div
                      key={factory.slug}
                      className="mt-2 pl-3 border-l"
                      style={{ borderColor: 'var(--line-subtle)' }}
                    >
                      <div className="text-[11px] font-semibold" style={{ color: 'var(--ink-secondary)' }}>
                        {factory.name}
                      </div>
                      <ul className="mt-1 space-y-1">
                        {factory.lines.map((line) => (
                          <li
                            key={line.lineId}
                            className="flex items-center justify-between gap-2 text-[10px]"
                          >
                            <span className="truncate" style={{ color: 'var(--ink-secondary)' }}>
                              {line.lineId}
                              <span style={{ color: 'var(--ink-muted)' }}> → {line.produces}</span>
                            </span>
                            <span className="shrink-0 flex items-center gap-2">
                              <span className="tabular" style={{ color: 'var(--ink-muted)' }}>
                                {count(line.throughput)} {line.throughputUnit}
                              </span>
                              <StatusChip role={roleFor(line.status)} label={line.status} />
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </GlassPanel>

        {/* ------------------------------------------------------ warehouses */}
        <GlassPanel as="section" aria-label="Inventory clusters">
          <PanelHeading
            icon={<Warehouse className="w-4 h-4" style={{ color: 'var(--accent)' }} />}
            title="Inventory clusters"
            subtitle="Select a holding to see the mandate's reasoning."
          />

          <div className="space-y-3" role="listbox" aria-label="Inventory holdings">
            {v.warehouses.map((warehouse) => (
              <div
                key={warehouse.slug}
                className="rounded-[var(--radius-md)] border p-3"
                style={{ background: 'var(--surface-2)', borderColor: 'var(--line-subtle)' }}
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span
                    className="text-[11px] font-semibold flex items-center gap-1.5"
                    style={{ color: 'var(--ink-primary)' }}
                  >
                    <Boxes className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} aria-hidden="true" />
                    {warehouse.name}
                  </span>
                  <span className="text-[10px] tabular" style={{ color: 'var(--ink-muted)' }}>
                    {warehouse.nodeId}
                  </span>
                </div>

                <Meter
                  label="Storage"
                  value={warehouse.utilisation}
                  detail={`${count(warehouse.storageUsedTb)} / ${count(warehouse.storageCapacityTb)} TB`}
                />

                <ul className="space-y-2 mt-2">
                  {v.blocks
                    .filter((b) => b.warehouseSlug === warehouse.slug)
                    .map((block) => {
                      const id = `${block.warehouseSlug}:${block.assetClass}`;
                      const isOpen = selected === id;
                      return (
                        <QuantumCard
                          key={id}
                          selected={isOpen}
                          onSelect={() => setSelected(isOpen ? null : id)}
                          label={`${block.assetClass} in ${block.warehouseName}, ${VERDICT_LABEL[block.verdict]}`}
                          className="!p-2.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] truncate" style={{ color: 'var(--ink-secondary)' }}>
                              {block.assetClass}
                              <span style={{ color: 'var(--ink-muted)' }}>
                                {' '}
                                · {count(block.quantity)} blocks
                              </span>
                            </span>
                            <StatusChip role={roleFor(block.verdict)} label={VERDICT_LABEL[block.verdict]} />
                          </div>

                          <div className="text-[10px] mt-1 tabular" style={{ color: 'var(--ink-muted)' }}>
                            acq {usd(block.acquisitionCostPerUnit)} · strike +{strikePct}%{' '}
                            {usd(block.strikeFloor)} · stop −{stopPct}% {usd(block.stopFloor)} · bid{' '}
                            <span className="font-semibold" style={{ color: 'var(--ink-primary)' }}>
                              {usd(block.marketBidFloor)}
                            </span>
                          </div>

                          <div
                            className="text-[10px] mt-0.5 tabular"
                            style={{
                              color:
                                block.netYieldPerUnit >= 0
                                  ? 'var(--status-good-ink)'
                                  : 'var(--status-critical-ink)',
                            }}
                          >
                            net {block.netYieldPerUnit >= 0 ? '+' : ''}
                            {block.netYieldPerUnit.toFixed(4)}/block ({signedUsd(block.netYieldTotal)} total)
                          </div>

                          {isOpen && (
                            <p
                              className="text-[10px] mt-2 pt-2 border-t leading-relaxed"
                              style={{ color: 'var(--ink-secondary)', borderColor: 'var(--line-subtle)' }}
                            >
                              {block.reason}
                            </p>
                          )}
                        </QuantumCard>
                      );
                    })}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-3 flex justify-end">
            <Button size="sm" variant="ghost" onClick={() => void load()}>
              Refresh graph
            </Button>
          </div>
        </GlassPanel>
      </div>
    </div>
  );
};
