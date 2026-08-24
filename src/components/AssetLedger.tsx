import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Ban,
  CheckCircle2,
  Gauge,
  Play,
  RefreshCw,
  ShieldAlert,
  X,
} from 'lucide-react';
import { User, ToastMessage } from '../types';
import { api, ApiError } from '../lib/api';
import {
  Alert,
  GlassPanel,
  KpiRow,
  QuantumCard,
  StatTile,
  StatusChip,
  count,
  roleFor,
  signedUsd,
  usd,
} from '../design';

// ---------------------------------------------------------------- types
interface AssetSpec {
  assetId: string;
  name: string;
  asset_class: string;
  price_increment: number;
  block_size: number;
  min_blocks: number;
  buy_fee_rate: number;
  sell_fee_rate: number;
  is_guaranteed: boolean;
  fundamentals_intact: boolean;
}

interface Quote {
  assetId: string;
  bid: number;
  ask: number;
  last: number;
  receivedAt: string;
  source: string;
}

interface Position {
  assetId: string;
  quantity: number;
  averageCost: number;
  realisedPnl: number;
  feesPaid: number;
  cashFlow: number;
  fillCount: number;
}

interface Plan {
  action: 'place_order' | 'hold';
  side?: 'buy' | 'sell';
  quantity?: number;
  type?: 'market' | 'limit';
  limitPrice?: number;
  timeInForce?: 'gtc' | 'ioc' | 'fok';
  reason: string;
  zeroLossSatisfied: boolean;
  /** `stopFloor` and `targetStrike` live here — the two numbers the mandate turns on. */
  diagnostics?: Record<string, number | string | boolean | null>;
}

interface Order {
  clientOrderId: string;
  assetId: string;
  side: 'buy' | 'sell';
  quantity: number;
  type: string;
  limitPrice?: number;
  status: string;
  filledQuantity: number;
  averageFillPrice: number;
  feesPaid: number;
  createdAt: string;
  actorName: string | null;
  rejectReason?: string | null;
}

interface FillRow {
  id: string;
  assetId: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  fee: number;
  timestamp: string;
}

interface RiskState {
  halted: boolean;
  haltReason?: string;
  maxOrderNotional: number;
  maxDailyNotional: number;
  maxPositionNotional: number;
  maxQuoteAgeMs: number;
  dailyNotionalUsed: number;
}

interface DeskRow {
  spec: AssetSpec;
  quote: Quote | null;
  position: Position;
  unrealisedPnl: number;
  plan: Plan;
}

interface DeskState {
  mode: 'internal' | 'galaxy';
  marketplace: string;
  bidFeed: string;
  risk: RiskState;
  lastReconciliation: {
    ranAt: string;
    fillsReplayed: number;
    ordersUpdated: number;
    discrepancies: { clientOrderId: string; issue: string }[];
  } | null;
  rows: DeskRow[];
  orders: Order[];
  fills: FillRow[];
}

// ---------------------------------------------------------------- helpers

/** Diagnostics are loosely typed by design; render only what is actually a number. */
const num = (v: unknown, dp = 4) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(dp) : '—');

const TRADE_ROLES = ['Executive', 'Arbitrage Trader', 'System Admin'];
const RESUME_ROLES = ['Executive', 'System Admin'];

interface Props {
  user: User | null;
  onOpenAuth: () => void;
  addToast?: (toast: Omit<ToastMessage, 'id' | 'timestamp'>) => void;
}

export const AssetLedger: React.FC<Props> = ({ user, onOpenAuth, addToast }) => {
  const [state, setState] = useState<DeskState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const canTrade = Boolean(user && TRADE_ROLES.includes(user.role));
  const canResume = Boolean(user && RESUME_ROLES.includes(user.role));

  const load = useCallback(async () => {
    try {
      const data = await api.get<DeskState>('/api/execution/state');
      setState(data);
      setSelected((cur) => cur ?? data.rows[0]?.spec.assetId ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the desk.');
    }
  }, []);

  // Quotes and fills move on their own; poll rather than pretending it is static.
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);

  const selectedRow = useMemo(
    () => state?.rows.find((r) => r.spec.assetId === selected) ?? null,
    [state, selected],
  );

  const act = async (label: string, fn: () => Promise<void>) => {
    if (!user) {
      onOpenAuth();
      return;
    }
    setBusy(label);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Request failed.';
      setError(message);
      addToast?.({
        type: err instanceof ApiError && err.status === 409 ? 'warning' : 'error',
        title: err instanceof ApiError && err.status === 409 ? 'Refused by risk controls' : 'Request failed',
        description: message,
        duration: 7000,
      });
    } finally {
      setBusy(null);
    }
  };

  const executePlan = (row: DeskRow) =>
    act('plan', async () => {
      const { plan, spec } = row;
      if (plan.action !== 'place_order') return;
      const result = await api.post<{ order: Order; resolvedAfterFailure: string | null }>(
        '/api/execution/order',
        {
          assetId: spec.assetId,
          side: plan.side,
          quantity: plan.quantity,
          type: plan.type,
          limitPrice: plan.limitPrice,
          timeInForce: plan.timeInForce,
          reason: `strategy: ${plan.reason.slice(0, 120)}`,
        },
      );
      addToast?.({
        type: 'success',
        title: `Order ${result.order.status}`,
        description: `${plan.side} ${plan.quantity} ${spec.assetId}${
          result.resolvedAfterFailure ? ' — recovered after a marketplace failure' : ''
        }`,
      });
    });

  const cancelOrder = (clientOrderId: string) =>
    act(clientOrderId, async () => {
      await api.post(`/api/execution/order/${clientOrderId}/cancel`);
    });

  const toggleHalt = () =>
    act('halt', async () => {
      if (state?.risk.halted) {
        await api.post('/api/execution/resume');
        addToast?.({ type: 'success', title: 'Kill switch released', description: 'Settlement may proceed.' });
      } else {
        await api.post('/api/execution/halt', { reason: 'Halted from the asset ledger.' });
        addToast?.({
          type: 'warning',
          title: 'Kill switch engaged',
          description: 'All acquisition and settlement is refused until resumed.',
        });
      }
    });

  const reconcile = () =>
    act('reconcile', async () => {
      const { report } = await api.post<{ report: DeskState['lastReconciliation'] }>(
        '/api/execution/reconcile',
      );
      addToast?.({
        type: (report?.discrepancies.length ?? 0) > 0 ? 'warning' : 'success',
        title: 'Reconciliation complete',
        description: `${report?.fillsReplayed ?? 0} fills replayed, ${report?.discrepancies.length ?? 0} discrepancies.`,
      });
    });

  if (!state) {
    return (
      <div className="flex-1 flex items-center justify-center bg-zinc-950 text-xs text-zinc-500 font-mono">
        {error ?? 'Loading the asset ledger…'}
      </div>
    );
  }

  const working = state.orders.filter(
    (o) => !['filled', 'cancelled', 'rejected', 'expired'].includes(o.status),
  );

  return (
    <div className="flex-1 p-4 md:p-6 space-y-5 overflow-y-auto font-mono text-zinc-100 bg-zinc-950">
      {/* Halt banner. The kill switch must be impossible to miss. */}
      {state.risk.halted && (
        <Alert role="critical" title="Settlement halted." live="alert">
          {state.risk.haltReason ?? 'All acquisition and settlement is refused.'}
        </Alert>
      )}

      <Alert role="warning" title="Bids are modelled, not live." live="none">
        This ledger tracks the media blocks your production nodes hold. Bids come from the internal
        marketplace model, which partially fills, rejects and occasionally drops the connection on purpose so
        the recovery paths stay exercised. Nothing here reaches an external exchange, and nothing is meant to.
      </Alert>

      {/* Header */}
      <GlassPanel>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-cyan-950 border border-cyan-500/40 text-cyan-400">
              <Gauge className="w-6 h-6" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-base font-bold text-zinc-100">Asset ledger</h2>
              <p className="text-[11px] text-zinc-400 font-sans">
                Marketplace <span className="text-zinc-200">{state.marketplace}</span> · bid feed{' '}
                <span className="text-zinc-200">{state.bidFeed}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void reconcile()}
              disabled={!canResume || busy === 'reconcile'}
              title={canResume ? 'Reconcile the ledger against the marketplace' : 'Requires Executive or System Admin'}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs text-zinc-300 border border-zinc-700 flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy === 'reconcile' ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>Reconcile</span>
            </button>

            <button
              type="button"
              onClick={() => void toggleHalt()}
              disabled={busy === 'halt' || (state.risk.halted ? !canResume : !canTrade)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-bold border flex items-center gap-1.5 cursor-pointer disabled:opacity-40 transition-colors ${
                state.risk.halted
                  ? 'bg-emerald-700 hover:bg-emerald-600 border-emerald-500 text-white'
                  : 'bg-red-700 hover:bg-red-600 border-red-500 text-white'
              }`}
            >
              {state.risk.halted ? (
                <Play className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <Ban className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>{state.risk.halted ? 'Resume settlement' : 'Halt settlement'}</span>
            </button>
          </div>
        </div>

        <div className="mt-4 pt-3 border-t" style={{ borderColor: 'var(--line-subtle)' }}>
          <KpiRow>
            <StatTile
              label="24h settled notional"
              value={state.risk.dailyNotionalUsed}
              currency
              hint={`ceiling ${usd(state.risk.maxDailyNotional)}`}
            />
            <StatTile label="Max instruction" value={state.risk.maxOrderNotional} currency />
            <StatTile label="Max position" value={state.risk.maxPositionNotional} currency />
            <StatTile label="Bid staleness gate" value={`${count(state.risk.maxQuoteAgeMs)} ms`} />
          </KpiRow>
        </div>

        {state.lastReconciliation && (
          <div className="mt-3 text-[10px] text-zinc-500 font-sans">
            Last reconciliation {new Date(state.lastReconciliation.ranAt).toLocaleTimeString()} —{' '}
            {state.lastReconciliation.fillsReplayed} fills replayed,{' '}
            {state.lastReconciliation.ordersUpdated} orders updated,{' '}
            <span
              className={state.lastReconciliation.discrepancies.length > 0 ? 'text-amber-400 font-bold' : ''}
            >
              {state.lastReconciliation.discrepancies.length} discrepancies
            </span>
            .
          </div>
        )}
      </GlassPanel>

      {error && (
        <div
          role="alert"
          className="p-3 rounded-xl bg-red-950/60 border border-red-600/50 text-red-200 text-xs font-sans flex items-start gap-2"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {/* Instruments */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <div className="xl:col-span-2 space-y-3">
          {state.rows.map((row) => {
            const isSelected = selected === row.spec.assetId;
            const q = row.quote;
            const actionable = row.plan.action === 'place_order';

            return (
              <QuantumCard
                key={row.spec.assetId}
                selected={isSelected}
                onSelect={() => setSelected(row.spec.assetId)}
                label={`${row.spec.name}, ${row.plan.action === 'place_order' ? 'action available' : 'holding'}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-bold text-zinc-100 truncate">{row.spec.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-zinc-400 shrink-0">
                      {row.spec.assetId}
                    </span>
                  </div>
                  {q && (
                    <div className="text-[11px] font-mono flex items-center gap-2 shrink-0">
                      <span className="text-zinc-500">bid</span>
                      <span className="text-emerald-400 font-bold">{q.bid.toFixed(4)}</span>
                      <span className="text-zinc-500">ask</span>
                      <span className="text-rose-400 font-bold">{q.ask.toFixed(4)}</span>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[11px] mb-3">
                  <div>
                    <div className="text-[10px] text-zinc-500">Blocks held</div>
                    <div className={row.position.quantity === 0 ? 'text-zinc-500' : 'text-zinc-100 font-bold'}>
                      {row.position.quantity.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500">Acquisition cost</div>
                    <div className="text-zinc-300">
                      {row.position.quantity === 0 ? '—' : row.position.averageCost.toFixed(4)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500">Unrealised</div>
                    <div className={row.unrealisedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {row.position.quantity === 0 ? '—' : signedUsd(row.unrealisedPnl)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500">Realised</div>
                    <div className={row.position.realisedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {signedUsd(row.position.realisedPnl)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500">Fees</div>
                    <div className="text-zinc-400">{usd(row.position.feesPaid)}</div>
                  </div>
                </div>

                {/*
                  The mandate in two numbers. Spec §4: sell on a bid at or above
                  130% of acquisition; liquidate below the 15% trailing floor.
                  Showing them next to the live bid is the difference between an
                  operator trusting the verdict and taking it on faith.
                */}
                {row.position.quantity !== 0 && (
                  <div className="grid grid-cols-2 gap-2 text-[11px] mb-3">
                    <div className="p-2 rounded-lg bg-emerald-950/30 border border-emerald-500/25">
                      <div className="text-[10px] text-emerald-500/90">Strike target (+30%)</div>
                      <div className="text-emerald-300 font-bold">
                        {num(row.plan.diagnostics?.targetStrike)}
                        {q && Number(row.plan.diagnostics?.targetStrike) > 0 && (
                          <span className="text-emerald-600 font-normal">
                            {' '}
                            · bid {((q.bid / Number(row.plan.diagnostics!.targetStrike)) * 100).toFixed(0)}% of
                            target
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="p-2 rounded-lg bg-red-950/30 border border-red-500/25">
                      <div className="text-[10px] text-red-500/90">Stop floor (−15%)</div>
                      <div className="text-red-300 font-bold">{num(row.plan.diagnostics?.stopFloor)}</div>
                    </div>
                  </div>
                )}

                <div
                  className={`p-2.5 rounded-lg border text-[11px] flex items-start justify-between gap-3 ${
                    actionable
                      ? row.plan.zeroLossSatisfied
                        ? 'bg-emerald-950/40 border-emerald-500/40'
                        : 'bg-red-950/40 border-red-500/40'
                      : 'bg-zinc-950 border-zinc-800'
                  }`}
                >
                  <div className="min-w-0">
                    <div
                      className={`font-bold ${
                        actionable ? (row.plan.zeroLossSatisfied ? 'text-emerald-300' : 'text-red-300') : 'text-zinc-400'
                      }`}
                    >
                      {actionable
                        ? `${row.plan.side?.toUpperCase()} ${row.plan.quantity} ${row.plan.type === 'limit' ? `@ ${row.plan.limitPrice}` : '@ market'}`
                        : 'HOLD'}
                    </div>
                    <p className="text-zinc-400 font-sans mt-0.5">{row.plan.reason}</p>
                  </div>

                  {actionable && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void executePlan(row);
                      }}
                      disabled={busy !== null || state.risk.halted || !canTrade}
                      title={
                        state.risk.halted
                          ? 'Settlement is halted'
                          : canTrade
                            ? 'Place this order'
                            : 'Your role cannot place orders'
                      }
                      className="shrink-0 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:cursor-not-allowed text-white text-[11px] font-bold cursor-pointer"
                    >
                      {busy === 'plan' ? 'Placing…' : 'Execute'}
                    </button>
                  )}
                </div>
              </QuantumCard>
            );
          })}
        </div>

        {/* Working orders + fills */}
        <div className="space-y-5">
          <GlassPanel>
            <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-wide mb-3 flex items-center gap-2">
              <Activity className="w-4 h-4 text-cyan-400" aria-hidden="true" />
              <span>In-flight instructions ({working.length})</span>
            </h3>

            {working.length === 0 ? (
              <p className="text-[11px] text-zinc-500 font-sans text-center py-4">Nothing in flight.</p>
            ) : (
              <ul className="space-y-2">
                {working.map((order) => (
                  <li key={order.clientOrderId} className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-[11px] font-bold text-zinc-200 truncate">
                        {order.side.toUpperCase()} {order.quantity} {order.assetId}
                      </span>
                      <StatusChip role={roleFor(order.status)} label={order.status.replace(/_/g, ' ')} />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] text-zinc-500">
                        filled {order.filledQuantity}/{order.quantity}
                        {order.averageFillPrice > 0 && ` @ ${order.averageFillPrice.toFixed(4)}`}
                      </span>
                      <button
                        type="button"
                        onClick={() => void cancelOrder(order.clientOrderId)}
                        disabled={busy !== null || !canTrade}
                        className="text-[10px] text-zinc-400 hover:text-red-300 flex items-center gap-1 cursor-pointer disabled:opacity-40"
                      >
                        <X className="w-3 h-3" aria-hidden="true" />
                        cancel
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </GlassPanel>

          <GlassPanel>
            <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-wide mb-3 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" aria-hidden="true" />
              <span>Recent settlements</span>
            </h3>

            {state.fills.length === 0 ? (
              <p className="text-[11px] text-zinc-500 font-sans text-center py-4">No settlements yet.</p>
            ) : (
              <ul className="space-y-1.5 max-h-72 overflow-y-auto">
                {state.fills.slice(0, 20).map((fill) => (
                  <li
                    key={fill.id}
                    className="flex items-center justify-between gap-2 text-[10px] p-2 rounded bg-zinc-950 border border-zinc-800"
                  >
                    <span
                      className={`font-bold shrink-0 ${fill.side === 'buy' ? 'text-cyan-400' : 'text-emerald-400'}`}
                    >
                      {fill.side.toUpperCase()}
                    </span>
                    <span className="text-zinc-300 flex-1 truncate">
                      {fill.quantity} @ {fill.price.toFixed(4)}
                    </span>
                    <span className="text-zinc-500 shrink-0">fee {fill.fee.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            )}
          </GlassPanel>

          {selectedRow && (
            <GlassPanel className="text-[11px] space-y-1.5">
              <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-wide mb-2 flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-amber-400" aria-hidden="true" />
                <span>Asset class rules</span>
              </h3>
              {[
                ['Price increment', selectedRow.spec.price_increment],
                ['Block size', selectedRow.spec.block_size],
                ['Minimum blocks', selectedRow.spec.min_blocks],
                ['Buy fee', `${(selectedRow.spec.buy_fee_rate * 100).toFixed(2)}%`],
                ['Sell fee', `${(selectedRow.spec.sell_fee_rate * 100).toFixed(2)}%`],
                ['Guaranteed', selectedRow.spec.is_guaranteed ? 'yes' : 'no'],
                ['Fundamentals', selectedRow.spec.fundamentals_intact ? 'intact' : 'INVALIDATED'],
              ].map(([label, value]) => (
                <div key={String(label)} className="flex justify-between">
                  <span className="text-zinc-500">{label}</span>
                  <span className="text-zinc-300">{String(value)}</span>
                </div>
              ))}
            </GlassPanel>
          )}
        </div>
      </div>
    </div>
  );
};
