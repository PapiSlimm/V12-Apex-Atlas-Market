import React from 'react';
import { User, UserRole } from '../types';
import { Shield, Lock, Key, UserCheck, CheckCircle2, MinusCircle } from 'lucide-react';

interface SecurityAuthProps {
  user: User | null;
  sessionChecked: boolean;
  onOpenAuth: () => void;
}

/*
 * Mirrors the server-side `requireRole` guards.
 *
 * The comment here used to claim the UI "cannot drift" from the server. It had
 * already drifted: four capabilities were listed against ten `requireRole` call
 * sites, and the three missing ones were the kill switch, reconciliation, and
 * reading the audit log — precisely the capabilities an operator reviewing
 * access control would want to see. Discipline is not a mechanism.
 *
 * The honest statement is that this list is maintained by hand and is checked
 * against `server.ts` when either changes. Generating it from a shared constant
 * that `server.ts` also consumes is the real fix and is not done yet.
 */
const CAPABILITIES: { capability: string; roles: UserRole[]; detail: string }[] = [
  {
    capability: 'Execute Hermes settlements',
    roles: ['Executive', 'Arbitrage Trader', 'System Admin'],
    detail: 'POST /api/hermes/trade — re-evaluated server-side before execution.',
  },
  {
    capability: 'Edit vault nodes',
    roles: ['Executive', 'System Admin', 'LoRABlender Engineer'],
    detail: 'PUT /api/vault/node — content capped at 100,000 characters.',
  },
  {
    capability: 'Call model endpoints',
    roles: ['Executive', 'Arbitrage Trader', 'LoRABlender Engineer', 'System Admin'],
    detail: 'Authenticated and rate limited to 20 requests per minute.',
  },
  {
    capability: 'Place ledger instructions',
    roles: ['Executive', 'Arbitrage Trader', 'System Admin'],
    detail: 'POST /api/execution/order — risk-assessed server-side; refusals are audited.',
  },
  {
    capability: 'Halt settlement',
    roles: ['Executive', 'Arbitrage Trader', 'System Admin'],
    detail: 'POST /api/execution/halt — the kill switch, checked before every instruction.',
  },
  {
    capability: 'Resume settlement and reconcile',
    roles: ['Executive', 'System Admin'],
    detail: 'POST /api/execution/resume and /reconcile — deliberately narrower than halting.',
  },
  {
    capability: 'Read the audit log',
    roles: ['Executive', 'System Admin'],
    detail: 'GET /api/audit — hash-chained and verified on read.',
  },
  {
    capability: 'Read positions and vault',
    roles: ['Executive', 'Arbitrage Trader', 'LoRABlender Engineer', 'System Admin'],
    detail: 'Read-only endpoints are public.',
  },
];

export const SecurityAuth: React.FC<SecurityAuthProps> = ({ user, sessionChecked, onOpenAuth }) => {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto font-mono text-zinc-100 bg-zinc-950">
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-5 shadow-xl backdrop-blur-md">
        <div className="flex items-center space-x-3 mb-2">
          <div className="p-2 rounded-lg bg-emerald-950 border border-emerald-500/40 text-emerald-400">
            <Shield className="w-6 h-6" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-base font-bold text-zinc-100">Session &amp; access control</h2>
            <p className="text-xs text-zinc-400 font-sans">
              Cookie-backed sessions, role-based authorisation, and the inactivity policy.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-5 shadow-xl space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-wide flex items-center space-x-2">
              <Key className="w-4 h-4 text-emerald-400" aria-hidden="true" />
              <span>Current session</span>
            </h3>
            {user ? (
              <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-500/30 font-bold">
                AUTHENTICATED
              </span>
            ) : (
              <button
                type="button"
                onClick={onOpenAuth}
                className="text-[10px] px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-bold cursor-pointer"
              >
                SIGN IN
              </button>
            )}
          </div>

          {!sessionChecked ? (
            <div className="p-6 text-center text-xs text-zinc-500">Checking session…</div>
          ) : user ? (
            <div className="space-y-3 text-xs">
              <dl className="p-3 bg-zinc-950 rounded-xl border border-zinc-800 space-y-2">
                {[
                  ['Name', user.name],
                  ['Email', user.email],
                  ['Role', user.role],
                  ['Account ID', user.id],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <dt className="text-zinc-400 shrink-0">{label}</dt>
                    <dd className="text-zinc-200 font-bold truncate text-right">{value}</dd>
                  </div>
                ))}
              </dl>

              {/*
                The raw bearer token used to be printed here in full. That put a
                complete credential into every screenshot, screen share and
                support ticket. It is now in an httpOnly cookie and is not
                available to this page at all — which is the point.
              */}
              <div className="p-3 bg-zinc-950 rounded-xl border border-emerald-500/30 space-y-1.5">
                <div className="text-emerald-400 font-bold flex items-center space-x-1.5">
                  <Lock className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Token storage</span>
                </div>
                <p className="text-[11px] text-zinc-400 font-sans leading-relaxed">
                  The session token is held in an <code className="text-zinc-200">httpOnly</code>,{' '}
                  <code className="text-zinc-200">SameSite=Strict</code> cookie with a 12-hour lifetime. Page
                  scripts cannot read it, so code executed in the REPL harness cannot exfiltrate your session.
                </p>
              </div>
            </div>
          ) : (
            <div className="p-6 bg-zinc-950 rounded-xl border border-zinc-800 text-center space-y-3">
              <Lock className="w-8 h-8 text-amber-400 mx-auto" aria-hidden="true" />
              <p className="text-xs text-zinc-300 font-sans">
                No active session. Reading positions and the vault works signed out; executing trades and
                editing notes does not.
              </p>
              <button
                type="button"
                onClick={onOpenAuth}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition-all cursor-pointer"
              >
                Sign in
              </button>
            </div>
          )}
        </div>

        <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-5 shadow-xl space-y-4">
          <div className="flex items-center space-x-2">
            <UserCheck className="w-4 h-4 text-cyan-400" aria-hidden="true" />
            <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-wide">
              Capabilities {user ? `for ${user.role}` : '(signed out)'}
            </h3>
          </div>

          <div className="space-y-2 text-xs">
            {CAPABILITIES.map((cap) => {
              const granted = Boolean(user && cap.roles.includes(user.role));
              return (
                <div
                  key={cap.capability}
                  className={`p-3 rounded-xl border space-y-1 ${
                    granted ? 'bg-zinc-950 border-emerald-500/30' : 'bg-zinc-950/60 border-zinc-800'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`font-bold ${granted ? 'text-emerald-400' : 'text-zinc-400'}`}>
                      {cap.capability}
                    </span>
                    {granted ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-label="Granted" />
                    ) : (
                      <MinusCircle className="w-4 h-4 text-zinc-600 shrink-0" aria-label="Not granted" />
                    )}
                  </div>
                  <p className="text-[11px] text-zinc-500 font-mono">{cap.detail}</p>
                </div>
              );
            })}
          </div>

          <div className="p-3.5 bg-zinc-950 rounded-xl border border-emerald-500/30 space-y-2">
            <div className="flex items-center justify-between text-xs gap-2">
              <span className="font-bold text-emerald-400 flex items-center space-x-1.5">
                <Shield className="w-4 h-4" aria-hidden="true" />
                <span>Inactivity policy</span>
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-500/40 font-bold shrink-0">
                15 MIN
              </span>
            </div>
            <p className="text-[11px] text-zinc-400 font-sans leading-relaxed">
              After 15 minutes without cursor or keyboard activity the client signs out and clears the session
              cookie. A warning appears 30 seconds before. The server-side cookie expires independently after
              12 hours.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
