import React, { useEffect, useRef, useState } from 'react';
import { User, UserRole } from '../types';
import { Mail, User as UserIcon, ShieldCheck, X, KeyRound, AlertCircle, Ticket } from 'lucide-react';
import { api } from '../lib/api';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuthSuccess: (user: User) => void;
}

const SELECTABLE_ROLES: { value: UserRole; label: string }[] = [
  { value: 'Executive', label: 'Executive — full governance' },
  { value: 'Arbitrage Trader', label: 'Arbitrage Trader — Hermes execution' },
  { value: 'LoRABlender Engineer', label: 'LoRABlender Engineer — routing & REPL' },
];

const MIN_PASSWORD_LENGTH = 12;

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose, onAuthSuccess }) => {
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('Executive');
  const [error, setError] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [loading, setLoading] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Escape to dismiss, focus moved into the dialog on open and restored on
  // close. None of this existed before, so keyboard users had no way out.
  useEffect(() => {
    if (!isOpen) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const focusTimer = setTimeout(() => firstFieldRef.current?.focus(), 30);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;

      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused.current?.focus?.();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const passwordTooShort = isRegister && password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (isRegister && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setLoading(true);
    try {
      // No token handling here any more — the server sets an httpOnly cookie.
      const data = await api.post<{ user: User }>(
        isRegister ? '/api/auth/register' : '/api/auth/login',
        isRegister ? { email, password, name, role, invite: inviteCode.trim() || undefined } : { email, password },
      );
      onAuthSuccess(data.user);
      setPassword('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 font-mono"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl p-6 relative text-zinc-100"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close sign-in dialog"
          className="absolute top-4 right-4 text-zinc-500 hover:text-zinc-300 p-1 rounded-lg transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-500"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>

        <div className="flex items-center space-x-3 mb-4">
          <img
            src="/media/logo-reverse-128.png"
            alt="Urban Visions Enterprises — V12 Multimedia"
            width={44}
            height={50}
            className="h-11 w-auto shrink-0"
            decoding="async"
          />
          <div>
            <h2 id="auth-modal-title" className="text-base font-bold text-zinc-100">
              {isRegister ? 'Create an account' : 'Sign in'}
            </h2>
            <p className="text-xs text-zinc-400 font-sans">
              {isRegister
                ? 'Credentials are hashed with bcrypt; sessions use an httpOnly cookie.'
                : 'Required for ledger instructions and vault edits.'}
            </p>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 p-3 bg-red-950/80 border border-red-700 rounded-xl text-xs text-red-200 flex items-start space-x-2"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span className="font-sans">{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {isRegister && (
            <>
              {/*
                Optional in the markup, required by the server when the
                deployment sets INVITE_ONLY. The client does not gate on it:
                whether a code is needed is the server's decision, and a UI that
                decides it locally is a UI that can be wrong about it.
              */}
              <div>
                <label htmlFor="auth-invite" className="block text-xs font-bold text-zinc-400 mb-1">
                  Invite code{' '}
                  <span className="font-normal text-zinc-500">— required during the closed beta</span>
                </label>
                <div className="relative">
                  <Ticket className="w-4 h-4 text-zinc-500 absolute left-3 top-3" aria-hidden="true" />
                  <input
                    id="auth-invite"
                    ref={isRegister ? firstFieldRef : undefined}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="XXXXX-XXXXX-XXXXX"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-9 pr-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500 font-mono tracking-wider uppercase"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="auth-name" className="block text-xs font-bold text-zinc-400 mb-1">
                  Full name
                </label>
                <div className="relative">
                  <UserIcon className="w-4 h-4 text-zinc-500 absolute left-3 top-3" aria-hidden="true" />
                  <input
                    id="auth-name"
                    
                    type="text"
                    required
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-9 pr-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500 font-sans"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="auth-role" className="block text-xs font-bold text-zinc-400 mb-1">
                  Role
                </label>
                <select
                  id="auth-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as UserRole)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500 font-mono"
                >
                  {SELECTABLE_ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          <div>
            <label htmlFor="auth-email" className="block text-xs font-bold text-zinc-400 mb-1">
              Email address
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-zinc-500 absolute left-3 top-3" aria-hidden="true" />
              <input
                id="auth-email"
                ref={isRegister ? undefined : firstFieldRef}
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-9 pr-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500 font-sans"
              />
            </div>
          </div>

          <div>
            <label htmlFor="auth-password" className="block text-xs font-bold text-zinc-400 mb-1">
              Password
            </label>
            <div className="relative">
              <KeyRound className="w-4 h-4 text-zinc-500 absolute left-3 top-3" aria-hidden="true" />
              <input
                id="auth-password"
                type="password"
                required
                minLength={isRegister ? MIN_PASSWORD_LENGTH : undefined}
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                aria-describedby={isRegister ? 'auth-password-hint' : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-9 pr-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500 font-sans"
              />
            </div>
            {isRegister && (
              <p
                id="auth-password-hint"
                className={`mt-1 text-[10px] font-sans ${passwordTooShort ? 'text-amber-400' : 'text-zinc-500'}`}
              >
                Minimum {MIN_PASSWORD_LENGTH} characters.
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:cursor-not-allowed text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-emerald-600/20 cursor-pointer flex items-center justify-center space-x-2"
          >
            <ShieldCheck className="w-4 h-4" aria-hidden="true" />
            <span>{loading ? 'Working…' : isRegister ? 'Create account' : 'Sign in'}</span>
          </button>
        </form>

        <div className="mt-4 pt-3 border-t border-zinc-800 text-center text-xs text-zinc-400 font-sans">
          {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
          <button
            type="button"
            onClick={() => {
              setIsRegister(!isRegister);
              setError('');
            }}
            className="text-emerald-400 font-bold hover:underline font-mono cursor-pointer"
          >
            {isRegister ? 'Sign in' : 'Register'}
          </button>
        </div>
      </div>
    </div>
  );
};
