import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MarketAsset, HermesEvaluation, User, ToastMessage, TradeRecord } from '../types';
import {
  TrendingUp,
  ShieldAlert,
  CheckCircle2,
  DollarSign,
  ArrowUpRight,
  Lock,
  RefreshCw,
  AlertTriangle,
  FlaskConical,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { SupplyNetwork } from './SupplyNetwork';

interface RevenueBoardroomProps {
  user: User | null;
  onOpenAuth: () => void;
  addToast?: (toast: Omit<ToastMessage, 'id' | 'timestamp'>) => void;
}

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

/** Net proceeds per unit after both fee legs — mirrors the server engine. */
const netPerUnit = (a: MarketAsset, offer: number) =>
  offer * (1 - a.sell_fees) - a.acquisition_price * (1 + a.buy_fees);

const TRADE_ROLES = ['Executive', 'Arbitrage Trader', 'System Admin'];

export const RevenueBoardroom: React.FC<RevenueBoardroomProps> = ({ user, onOpenAuth, addToast }) => {
  const [assets, setAssets] = useState<MarketAsset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<HermesEvaluation | null>(null);
  const [tradeLogs, setTradeLogs] = useState<TradeRecord[]>([]);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [isTrading, setIsTrading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedAsset = useMemo(
    () => assets.find((a) => a.asset_id === selectedId) ?? null,
    [assets, selectedId],
  );

  const evaluateAsset = useCallback(async (assetId: string) => {
    setIsEvaluating(true);
    setError(null);
    try {
      const data = await api.post<{ evaluation: HermesEvaluation }>('/api/hermes/evaluate', {
        asset_id: assetId,
      });
      setEvaluation(data.evaluation);
    } catch (err) {
      setEvaluation(null);
      setError(err instanceof Error ? err.message : 'Evaluation failed.');
    } finally {
      setIsEvaluating(false);
    }
  }, []);

  const fetchAssets = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<{ assets: MarketAsset[] }>('/api/hermes/assets');
      const list = data.assets ?? [];
      setAssets(list);
      // Preserve the operator's selection across a refresh instead of snapping
      // back to the first row.
      setSelectedId((current) => {
        const next = current && list.some((a) => a.asset_id === current) ? current : list[0]?.asset_id ?? null;
        if (next) void evaluateAsset(next);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load positions.');
    }
  }, [evaluateAsset]);

  useEffect(() => {
    void fetchAssets();
  }, [fetchAssets]);

  // Trade history is server-owned now, so it survives a reload.
  useEffect(() => {
    if (!user) {
      setTradeLogs([]);
      return;
    }
    api
      .get<{ trades: TradeRecord[] }>('/api/hermes/trades')
      .then((data) => setTradeLogs(data.trades ?? []))
      .catch(() => undefined);
  }, [user]);

  const executeTrade = async (assetId: string) => {
    if (!user) {
      onOpenAuth();
      return;
    }
    setIsTrading(true);
    setError(null);
    try {
      const data = await api.post<{ tradeLog: TradeRecord }>('/api/hermes/trade', { asset_id: assetId });
      setTradeLogs((prev) => [data.tradeLog, ...prev]);
      addToast?.({
        type: 'success',
        title: 'Trade executed',
        description: `${data.tradeLog.quantity.toLocaleString()} units at ${usd(
          data.tradeLog.unit_price,
        )} — net ${usd(data.tradeLog.realized_net_total)}.`,
      });
      await fetchAssets();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Trade failed.';
      setError(message);
      addToast?.({
        type: 'error',
        title: err instanceof ApiError && err.status === 409 ? 'Execution refused' : 'Trade failed',
        description: message,
        duration: 7000,
      });
    } finally {
      setIsTrading(false);
    }
  };

  // These were hardcoded marketing figures before. They now derive from the
  // positions actually on the books.
  const portfolio = useMemo(() => {
    const markValue = assets.reduce(
      (sum, a) => sum + (a.active_offer ?? a.current_price) * a.quantity,
      0,
    );
    const costBasis = assets.reduce(
      (sum, a) => sum + a.acquisition_price * (1 + a.buy_fees) * a.quantity,
      0,
    );
    const unrealised = assets.reduce(
      (sum, a) => sum + netPerUnit(a, a.active_offer ?? a.current_price) * a.quantity,
      0,
    );
    const realised = tradeLogs.reduce((sum, t) => sum + t.realized_net_total, 0);
    return { markValue, costBasis, unrealised, realised };
  }, [assets, tradeLogs]);

  const canTrade = Boolean(user && TRADE_ROLES.includes(user.role));

  return (
    <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto font-mono text-zinc-100 bg-zinc-950">
      {/* Simulated-data disclosure. The figures below look like a live trading
          desk; nobody should mistake them for one. */}
      <div className="flex items-start space-x-2 p-3 rounded-xl bg-amber-950/40 border border-amber-500/40 text-amber-200">
        <FlaskConical className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
        <p className="text-[11px] font-sans leading-relaxed">
          <strong className="font-bold">Bids are modelled.</strong> The supply network below is real — it is
          parsed from your vault and recomputes when you edit it. The bid prices driving these verdicts come
          from the internal marketplace model rather than observed counterparties, so treat the mandate logic
          as live and the prices as illustrative.
        </p>
      </div>

      {/* The twin, computed. Placed above the position list because the graph is
          what the positions are *of* — inventory without the network that
          produced it is just a spreadsheet. */}
      <SupplyNetwork />

      <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-5 shadow-xl backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-lg bg-emerald-950 border border-emerald-500/40 text-emerald-400">
              <TrendingUp className="w-6 h-6" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-base font-bold text-zinc-100">Hermes profit boardroom</h2>
              <p className="text-xs text-zinc-400 font-sans">
                Continuous arbitrage evaluation under a zero-loss mandate (Δπ &gt; 0), enforced server-side on
                every execution.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void fetchAssets()}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 border border-zinc-700 flex items-center space-x-1.5 transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Refresh positions</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 pt-3 border-t border-zinc-800/80">
          <div className="bg-zinc-950 p-3 rounded-lg border border-zinc-800">
            <div className="text-[10px] text-zinc-500 uppercase">Mark value</div>
            <div className="text-lg font-bold text-zinc-100">{usd(portfolio.markValue)}</div>
          </div>
          <div className="bg-zinc-950 p-3 rounded-lg border border-zinc-800">
            <div className="text-[10px] text-zinc-500 uppercase">Cost basis (incl. buy fees)</div>
            <div className="text-lg font-bold text-zinc-300">{usd(portfolio.costBasis)}</div>
          </div>
          <div className="bg-zinc-950 p-3 rounded-lg border border-zinc-800">
            <div className="text-[10px] text-zinc-500 uppercase">Unrealised, net of fees</div>
            <div
              className={`text-lg font-bold ${portfolio.unrealised >= 0 ? 'text-emerald-400' : 'text-red-400'}`}
            >
              {portfolio.unrealised >= 0 ? '+' : ''}
              {usd(portfolio.unrealised)}
            </div>
          </div>
          <div className="bg-zinc-950 p-3 rounded-lg border border-zinc-800">
            <div className="text-[10px] text-zinc-500 uppercase">Realised this account</div>
            <div className="text-lg font-bold text-cyan-400">
              {portfolio.realised >= 0 ? '+' : ''}
              {usd(portfolio.realised)}
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="p-3 rounded-xl bg-red-950/60 border border-red-600/50 text-red-200 text-xs font-sans flex items-start space-x-2"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-wide flex items-center space-x-2">
                <DollarSign className="w-4 h-4 text-emerald-400" aria-hidden="true" />
                <span>Open positions</span>
              </h3>
              <span className="text-[10px] text-zinc-500">{assets.length} asset classes</span>
            </div>

            <div className="space-y-3" role="listbox" aria-label="Open positions">
              {assets.length === 0 && (
                <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800 text-xs text-zinc-500 text-center">
                  No positions loaded.
                </div>
              )}

              {assets.map((asset) => {
                const isSelected = selectedId === asset.asset_id;
                const offer = asset.active_offer ?? asset.current_price;
                const grossPct = ((offer - asset.acquisition_price) / asset.acquisition_price) * 100;
                const net = netPerUnit(asset, offer);
                const netPct = (net / (asset.acquisition_price * (1 + asset.buy_fees))) * 100;
                const isFlat = asset.quantity <= 0;

                return (
                  <div
                    key={asset.asset_id}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={0}
                    onClick={() => {
                      setSelectedId(asset.asset_id);
                      void evaluateAsset(asset.asset_id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedId(asset.asset_id);
                        void evaluateAsset(asset.asset_id);
                      }
                    }}
                    className={`p-4 rounded-xl border transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
                      isSelected
                        ? 'bg-zinc-950 border-emerald-500/60 shadow-lg shadow-emerald-950/30'
                        : 'bg-zinc-950/60 border-zinc-800 hover:border-zinc-700'
                    } ${isFlat ? 'opacity-60' : ''}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                      <div className="flex items-center space-x-2">
                        <span className="text-xs font-bold text-zinc-100">{asset.name}</span>
                        <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
                          {asset.asset_class}
                        </span>
                        {!asset.is_guaranteed && (
                          <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-900 border border-amber-500/40 text-amber-400">
                            not guaranteed
                          </span>
                        )}
                      </div>
                      {isFlat ? (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-zinc-900 text-zinc-400 border border-zinc-700">
                          closed
                        </span>
                      ) : (
                        net > 0 &&
                        grossPct >= 30 && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-500/40">
                            strike target cleared
                          </span>
                        )
                      )}
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[11px] mt-2 font-mono">
                      <div>
                        <div className="text-[10px] text-zinc-500">Acquisition</div>
                        <div className="text-zinc-300">{usd(asset.acquisition_price)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-zinc-500">Live offer</div>
                        <div className="text-zinc-100 font-bold">{usd(offer)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-zinc-500">Gross</div>
                        <div className={grossPct >= 0 ? 'text-zinc-300' : 'text-red-400'}>
                          {grossPct >= 0 ? '+' : ''}
                          {grossPct.toFixed(1)}%
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-zinc-500">Net of fees</div>
                        <div className={net > 0 ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
                          {netPct >= 0 ? '+' : ''}
                          {netPct.toFixed(1)}%
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-zinc-500">Inventory</div>
                        <div className="text-zinc-300">{asset.quantity.toLocaleString()}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 shadow-xl">
            <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-wide mb-3 flex items-center space-x-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" aria-hidden="true" />
              <span>Execution log</span>
            </h3>

            {tradeLogs.length === 0 ? (
              <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800 text-xs text-zinc-500 text-center font-sans">
                {user
                  ? 'No executions recorded yet.'
                  : 'Sign in to view the execution log for your account.'}
              </div>
            ) : (
              <div className="space-y-2 text-xs">
                {tradeLogs.map((log) => (
                  <div
                    key={log.id}
                    className="p-3 bg-zinc-950 rounded-lg border border-emerald-500/30 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-emerald-400 font-bold truncate">
                        {log.action} · {log.asset_id}
                      </div>
                      <div className="text-[10px] text-zinc-400 truncate">
                        {log.quantity.toLocaleString()} units @ {usd(log.unit_price)} · {log.executedBy}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div
                        className={`font-bold text-sm ${
                          log.realized_net_total >= 0 ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {log.realized_net_total >= 0 ? '+' : ''}
                        {usd(log.realized_net_total)}
                      </div>
                      <div className="text-[10px] text-zinc-500">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 shadow-xl">
            <div className="flex items-center space-x-2 mb-3">
              <ShieldAlert className="w-4 h-4 text-amber-400" aria-hidden="true" />
              <h3 className="text-xs font-bold text-zinc-200">Zero-loss evaluator</h3>
            </div>

            {isEvaluating && !evaluation ? (
              <div className="text-xs text-zinc-500 text-center py-6">Evaluating…</div>
            ) : selectedAsset && evaluation ? (
              <div className="space-y-4 text-xs font-mono">
                <div className="bg-zinc-950 p-3 rounded-lg border border-zinc-800">
                  <div className="text-[10px] text-zinc-500 mb-1">Instrument</div>
                  <div className="font-bold text-zinc-200">{selectedAsset.name}</div>
                  <div className="text-[10px] text-zinc-400 mt-1">{selectedAsset.asset_id}</div>
                </div>

                <div
                  className={`p-3.5 rounded-xl border bg-zinc-950 ${
                    evaluation.action === 'EXECUTE_SELL'
                      ? 'border-emerald-500/40'
                      : evaluation.action === 'SELL_IMMEDIATELY'
                        ? 'border-red-500/50'
                        : 'border-zinc-800'
                  }`}
                >
                  <div className="text-[10px] text-zinc-500 mb-1">Engine decision</div>
                  <div
                    className={`font-bold text-sm ${
                      evaluation.action === 'EXECUTE_SELL'
                        ? 'text-emerald-400'
                        : evaluation.action === 'SELL_IMMEDIATELY'
                          ? 'text-red-400'
                          : 'text-amber-400'
                    }`}
                  >
                    {evaluation.action.replace(/_/g, ' ')}
                  </div>
                  <p className="text-xs text-zinc-300 mt-1 font-sans">{evaluation.reason}</p>
                </div>

                <div className="space-y-2 text-[11px]">
                  <div className="flex justify-between p-2 rounded bg-zinc-950 border border-zinc-800">
                    <span className="text-zinc-400">Stop-loss floor</span>
                    <span className="text-amber-400 font-bold">{usd(evaluation.stop_loss_floor)}</span>
                  </div>
                  <div className="flex justify-between p-2 rounded bg-zinc-950 border border-zinc-800">
                    <span className="text-zinc-400">Strike target</span>
                    <span className="text-emerald-400 font-bold">{usd(evaluation.target_strike)}</span>
                  </div>
                  {evaluation.realized_net_per_unit !== undefined && (
                    <div className="flex justify-between p-2 rounded bg-zinc-950 border border-zinc-800">
                      <span className="text-zinc-400">Net per unit</span>
                      <span
                        className={`font-bold ${
                          evaluation.realized_net_per_unit > 0 ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {usd(evaluation.realized_net_per_unit)}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between p-2 rounded bg-zinc-950 border border-zinc-800">
                    <span className="text-zinc-400">Zero-loss satisfied</span>
                    <span
                      className={`font-bold ${evaluation.zero_loss_satisfied ? 'text-emerald-400' : 'text-zinc-400'}`}
                    >
                      {evaluation.zero_loss_satisfied ? 'yes' : 'no'}
                    </span>
                  </div>
                </div>

                {evaluation.action === 'EXECUTE_SELL' || evaluation.action === 'SELL_IMMEDIATELY' ? (
                  !user ? (
                    <button
                      type="button"
                      onClick={onOpenAuth}
                      className="w-full py-2.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg font-bold flex items-center justify-center space-x-2 transition-all cursor-pointer"
                    >
                      <Lock className="w-4 h-4" aria-hidden="true" />
                      <span>Sign in to execute</span>
                    </button>
                  ) : !canTrade ? (
                    <div className="p-2.5 bg-zinc-950 rounded-lg border border-amber-500/40 text-[11px] text-amber-300 text-center font-sans">
                      Your role ({user.role}) cannot execute trades. An Executive or Arbitrage Trader must
                      action this.
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void executeTrade(selectedAsset.asset_id)}
                      disabled={isTrading}
                      className={`w-full py-2.5 rounded-lg font-bold flex items-center justify-center space-x-2 shadow-lg transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed ${
                        evaluation.action === 'SELL_IMMEDIATELY'
                          ? 'bg-red-600 hover:bg-red-500 text-white shadow-red-600/30'
                          : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/30'
                      }`}
                    >
                      <ArrowUpRight className="w-4 h-4" aria-hidden="true" />
                      <span>
                        {isTrading
                          ? 'Executing…'
                          : evaluation.action === 'SELL_IMMEDIATELY'
                            ? 'Execute risk exit'
                            : 'Execute zero-loss trade'}
                      </span>
                    </button>
                  )
                ) : (
                  <div className="p-2.5 bg-zinc-950 rounded-lg border border-zinc-800 text-[10px] text-zinc-500 text-center font-sans">
                    No action available. The engine will refuse execution while it returns{' '}
                    {evaluation.action.replace(/_/g, ' ')}.
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-zinc-500 text-center py-6">Select a position to evaluate.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
