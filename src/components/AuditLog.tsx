import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ScrollText,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  Lock,
  CheckCircle2,
  XCircle,
  Info,
  Link2,
  Download,
} from 'lucide-react';
import { User, ToastMessage } from '../types';
import { api, ApiError } from '../lib/api';

interface AuditEntry {
  seq: number;
  id: string;
  timestamp: string;
  event: string;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  subject: string | null;
  outcome: 'allowed' | 'refused' | 'info';
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

interface ChainVerification {
  ok: boolean;
  entries: number;
  brokenAt?: number;
  reason?: string;
}

interface AuditLogProps {
  user: User | null;
  onOpenAuth: () => void;
  addToast?: (toast: Omit<ToastMessage, 'id' | 'timestamp'>) => void;
}

const READER_ROLES = ['Executive', 'System Admin'];

const OUTCOME_STYLE: Record<AuditEntry['outcome'], { cls: string; Icon: React.ElementType }> = {
  allowed: { cls: 'text-emerald-400 border-emerald-500/40 bg-emerald-950/40', Icon: CheckCircle2 },
  refused: { cls: 'text-amber-400 border-amber-500/40 bg-amber-950/40', Icon: XCircle },
  info: { cls: 'text-zinc-400 border-zinc-700 bg-zinc-900/60', Icon: Info },
};

export const AuditLog: React.FC<AuditLogProps> = ({ user, onOpenAuth, addToast }) => {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [chain, setChain] = useState<ChainVerification | null>(null);
  const [filter, setFilter] = useState<'all' | 'allowed' | 'refused'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canRead = Boolean(user && READER_ROLES.includes(user.role));

  const load = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ entries: AuditEntry[]; chain: ChainVerification }>('/api/audit?limit=200');
      setEntries(data.entries ?? []);
      setChain(data.chain ?? null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onOpenAuth();
      setError(err instanceof Error ? err.message : 'Could not load the audit log.');
    } finally {
      setLoading(false);
    }
  }, [canRead, onOpenAuth]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () => (filter === 'all' ? entries : entries.filter((e) => e.outcome === filter)),
    [entries, filter],
  );

  const counts = useMemo(
    () => ({
      all: entries.length,
      allowed: entries.filter((e) => e.outcome === 'allowed').length,
      refused: entries.filter((e) => e.outcome === 'refused').length,
    }),
    [entries],
  );

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ chain, entries }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `apex_audit_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
    addToast?.({
      type: 'success',
      title: 'Audit log exported',
      description: `${entries.length} entries with their hash chain.`,
    });
  };

  if (!user) {
    return (
      <div className="flex-1 p-6 flex items-center justify-center bg-zinc-950">
        <div className="max-w-md text-center space-y-4 p-8 rounded-2xl bg-zinc-900/80 border border-zinc-800">
          <Lock className="w-8 h-8 text-amber-400 mx-auto" aria-hidden="true" />
          <h2 className="text-sm font-bold text-zinc-100 font-mono">Audit log is restricted</h2>
          <p className="text-xs text-zinc-400 font-sans">
            Sign in with an Executive or System Admin account to review the decision history.
          </p>
          <button
            type="button"
            onClick={onOpenAuth}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold cursor-pointer"
          >
            Sign in
          </button>
        </div>
      </div>
    );
  }

  if (!canRead) {
    return (
      <div className="flex-1 p-6 flex items-center justify-center bg-zinc-950">
        <div className="max-w-md text-center space-y-3 p-8 rounded-2xl bg-zinc-900/80 border border-amber-500/40">
          <ShieldAlert className="w-8 h-8 text-amber-400 mx-auto" aria-hidden="true" />
          <h2 className="text-sm font-bold text-zinc-100 font-mono">Insufficient role</h2>
          <p className="text-xs text-zinc-400 font-sans">
            Your role ({user.role}) cannot read the audit log. Executive or System Admin is required — the
            same check the server enforces.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto font-mono text-zinc-100 bg-zinc-950">
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-5 shadow-xl backdrop-blur-md">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-lg bg-indigo-950 border border-indigo-500/40 text-indigo-400">
              <ScrollText className="w-6 h-6" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-base font-bold text-zinc-100">Decision audit log</h2>
              <p className="text-xs text-zinc-400 font-sans max-w-xl">
                Append-only and hash-chained. Every execution decision is recorded — including the ones the
                engine refused, which is usually the half that matters in an investigation.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={exportJson}
              disabled={entries.length === 0}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-xs text-zinc-300 border border-zinc-700 flex items-center space-x-1.5 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Export</span>
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 border border-zinc-700 flex items-center space-x-1.5 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {chain && (
          <div
            className={`mt-4 p-3 rounded-xl border flex items-start gap-2.5 ${
              chain.ok
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                : 'bg-red-950/60 border-red-600/60 text-red-100'
            }`}
          >
            {chain.ok ? (
              <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            ) : (
              <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            )}
            <div className="text-[11px] font-sans leading-relaxed">
              {chain.ok ? (
                <>
                  <strong className="font-bold">Chain intact.</strong> All {chain.entries} entries verified —
                  each hash matches its recomputed value and links to its predecessor. Any modification,
                  deletion or reordering of a historical record would break this check.
                </>
              ) : (
                <>
                  <strong className="font-bold">Chain broken at entry {chain.brokenAt}.</strong> {chain.reason}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="p-3 rounded-xl bg-red-950/60 border border-red-600/50 text-red-200 text-xs font-sans"
        >
          {error}
        </div>
      )}

      <div className="flex items-center gap-2 text-xs">
        {(['all', 'allowed', 'refused'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={`px-3 py-1.5 rounded-lg border font-mono capitalize cursor-pointer transition-colors ${
              filter === f
                ? 'bg-zinc-800 border-emerald-500/50 text-emerald-300'
                : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {f} ({counts[f]})
          </button>
        ))}
      </div>

      <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl overflow-hidden shadow-xl">
        {visible.length === 0 ? (
          <div className="p-8 text-center text-xs text-zinc-500 font-sans">
            {loading ? 'Loading…' : 'No entries match this filter.'}
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800/80">
            {visible.map((entry) => {
              const { cls, Icon } = OUTCOME_STYLE[entry.outcome];
              const isOpen = expanded === entry.id;

              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : entry.id)}
                    aria-expanded={isOpen}
                    className="w-full text-left p-3.5 hover:bg-zinc-950/60 transition-colors cursor-pointer flex items-start gap-3"
                  >
                    <span className="text-[10px] text-zinc-600 font-mono pt-1 w-10 shrink-0 tabular-nums">
                      #{entry.seq}
                    </span>

                    <span
                      className={`px-1.5 py-0.5 rounded border text-[10px] font-bold flex items-center gap-1 shrink-0 ${cls}`}
                    >
                      <Icon className="w-3 h-3" aria-hidden="true" />
                      {entry.outcome}
                    </span>

                    <span className="flex-1 min-w-0">
                      <span className="block text-xs font-bold text-zinc-200 truncate">
                        {entry.event}
                        {entry.subject && <span className="text-zinc-500 font-normal"> · {entry.subject}</span>}
                      </span>
                      <span className="block text-[10px] text-zinc-500 truncate">
                        {entry.actorName ?? 'anonymous'}
                        {entry.actorRole ? ` (${entry.actorRole})` : ''} ·{' '}
                        {new Date(entry.timestamp).toLocaleString()}
                      </span>
                    </span>

                    <span className="text-[10px] text-zinc-600 font-mono shrink-0 hidden sm:flex items-center gap-1">
                      <Link2 className="w-3 h-3" aria-hidden="true" />
                      {entry.hash.slice(0, 8)}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="px-4 pb-4 space-y-2 bg-zinc-950/60">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[10px] font-mono">
                        <div className="p-2 rounded bg-zinc-950 border border-zinc-800 break-all">
                          <span className="text-zinc-500">prev </span>
                          <span className="text-zinc-400">{entry.prevHash}</span>
                        </div>
                        <div className="p-2 rounded bg-zinc-950 border border-zinc-800 break-all">
                          <span className="text-zinc-500">hash </span>
                          <span className="text-emerald-400">{entry.hash}</span>
                        </div>
                      </div>
                      <pre className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-[11px] text-zinc-300 overflow-x-auto">
                        {JSON.stringify(entry.detail, null, 2)}
                      </pre>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};
