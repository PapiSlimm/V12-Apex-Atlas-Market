import React from 'react';
import { User } from '../types';
import { Zap, User as UserIcon, Lock, Activity, Command, Clock, Globe, Eye } from 'lucide-react';
import { useLanguage, Language } from '../context/LanguageContext';
import { useTheme } from '../context/ThemeContext';

interface HeaderProps {
  user: User | null;
  onOpenAuth: () => void;
  onLogout: () => void;
  onOpenCommandPalette: () => void;
  syncLatency: number;
  secondsRemaining?: number;
}

export const Header: React.FC<HeaderProps> = ({
  user,
  onOpenAuth,
  onLogout,
  onOpenCommandPalette,
  syncLatency,
  secondsRemaining,
}) => {
  const { language, setLanguage, t } = useLanguage();
  const { toggleTheme, isHighContrast } = useTheme();

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <header className={`h-16 px-4 md:px-6 flex items-center justify-between sticky top-0 z-40 backdrop-blur-md border-b transition-all ${
      isHighContrast ? 'bg-black border-white text-white' : 'bg-zinc-950/95 border-zinc-800/80 text-zinc-100'
    }`}>
      {/* Left: Branding & OS Identity */}
      <div className="flex items-center space-x-3">
        {/* The house mark, not a stock CPU glyph. The reverse variant, because
            the supplied logo is chrome-on-white and its lower half disappears
            on this surface — see scripts/build-logo.py. */}
        <img
          src="/media/logo-reverse-128.png"
          alt="Urban Visions Enterprises — V12 Multimedia"
          width={36}
          height={41}
          className="h-9 w-auto shrink-0"
          decoding="async"
        />
        <div>
          <div className="flex items-center space-x-2">
            <h1 className="text-sm md:text-base font-bold font-mono tracking-tight">
              {t('appName')}
            </h1>
            <span className={`text-[10px] font-mono px-2 py-0.5 rounded font-medium ${
              isHighContrast ? 'bg-yellow-400 text-black border border-white font-extrabold' : 'bg-emerald-950/80 border border-emerald-500/30 text-emerald-400'
            }`}>
              Macaron-v1
            </span>
          </div>
          {/* Was a three-clause tagline that wrapped to two lines and pushed the
              header off its 64px grid at common widths. */}
          <p className="text-[11px] text-zinc-400 font-mono hidden xl:block whitespace-nowrap">
            Digital twin operations workspace
          </p>
        </div>
      </div>

      {/* Middle: Live Status Indicators */}
      <div className="hidden lg:flex items-center space-x-3 font-mono text-xs">
        <div className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-lg border ${
          isHighContrast ? 'bg-black border-white text-white' : 'bg-zinc-900 border-zinc-800 text-zinc-300'
        }`}>
          <Activity className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
          <span className="text-zinc-400">{t('status')}:</span>
          <span className="text-emerald-400 font-semibold">ONLINE</span>
        </div>

        <div className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-lg border ${
          isHighContrast ? 'bg-black border-white text-white' : 'bg-zinc-900 border-zinc-800 text-zinc-300'
        }`}>
          <Zap className="w-3.5 h-3.5 text-cyan-400" />
          <span className="text-zinc-400">{t('synchronizerLatency')}:</span>
          <span className="text-cyan-400 font-semibold">{syncLatency}ms Path</span>
        </div>

        {user && secondsRemaining !== undefined && (
          <div className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-lg border ${
            isHighContrast ? 'bg-black border-emerald-400 text-emerald-300' : 'bg-zinc-900 border-emerald-500/30 text-emerald-400'
          }`}>
            <Clock className="w-3.5 h-3.5 text-emerald-400 animate-spin" style={{ animationDuration: '6s' }} />
            <span className="text-zinc-400">{t('guard')}:</span>
            <span className="text-emerald-300 font-semibold">{formatTime(secondsRemaining)}</span>
          </div>
        )}
      </div>

      {/* Right: Cmd+K Search Palette, Theme Switcher, Localization & Auth Controls */}
      <div className="flex items-center space-x-2">
        {/* Theme Switcher Button */}
        <button
          onClick={toggleTheme}
          className={`flex items-center space-x-1.5 px-2.5 py-1.5 rounded-xl text-xs font-mono border transition-all cursor-pointer ${
            isHighContrast
              ? 'bg-yellow-400 text-black border-2 border-white font-bold shadow-sm'
              : 'bg-zinc-900 hover:bg-zinc-800 border-zinc-800 text-zinc-300'
          }`}
          title={isHighContrast ? "Switch to Sleek Theme" : "Switch to High Contrast Accessibility Mode"}
        >
          <Eye className="w-3.5 h-3.5" />
          <span className="hidden xl:inline">{isHighContrast ? t('highContrastTheme') : t('sleekTheme')}</span>
        </button>

        {/* Language Selector */}
        <div className="relative flex items-center">
          <Globe className="w-3.5 h-3.5 text-zinc-400 absolute left-2 pointer-events-none" />
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as Language)}
            className={`pl-6 pr-2 py-1.5 rounded-xl text-xs font-mono border appearance-none transition-all cursor-pointer ${
              isHighContrast
                ? 'bg-black text-white border-2 border-white font-bold'
                : 'bg-zinc-900 text-zinc-200 border-zinc-800 hover:bg-zinc-800'
            }`}
            title="Switch Workspace Language"
          >
            <option value="en">EN</option>
            <option value="ja">JA 日本語</option>
            <option value="zh">ZH 中文</option>
          </select>
        </div>

        {/* Command Palette button */}
        <button
          onClick={onOpenCommandPalette}
          className={`flex items-center space-x-1.5 px-2.5 py-1.5 rounded-xl text-xs font-mono border transition-all cursor-pointer group ${
            isHighContrast ? 'bg-black text-white border-2 border-white' : 'bg-zinc-900 hover:bg-zinc-800 border-zinc-700/80 text-zinc-300'
          }`}
          title="Open Global Command Palette (Cmd+K)"
        >
          <Command className="w-3.5 h-3.5 text-emerald-400 group-hover:rotate-12 transition-transform" />
          <span className="hidden sm:inline text-zinc-400">{t('search')}</span>
          <kbd className="px-1 py-0.5 text-[10px] bg-zinc-950 rounded border border-zinc-700 text-zinc-400 font-bold group-hover:border-emerald-500/50 group-hover:text-emerald-400">
            ⌘K
          </kbd>
        </button>

        {user ? (
          <div className="flex items-center space-x-2">
            <div className="text-right hidden sm:block">
              <div className="text-xs font-semibold font-mono flex items-center space-x-1 justify-end">
                <Lock className="w-3 h-3 text-emerald-400" />
                <span>{user.name}</span>
              </div>
              <div className="text-[10px] text-zinc-400 font-mono">
                Role: <span className="text-cyan-400">{user.role}</span>
              </div>
            </div>

            <button
              onClick={onLogout}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-mono border transition-colors cursor-pointer ${
                isHighContrast ? 'bg-white text-black font-bold border-white' : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border-zinc-700'
              }`}
              title="JWT Logout"
            >
              {t('signOut')}
            </button>
          </div>
        ) : (
          <button
            onClick={onOpenAuth}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-medium bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20 transition-all cursor-pointer"
          >
            <UserIcon className="w-3.5 h-3.5" />
            <span>{t('signIn')}</span>
          </button>
        )}
      </div>
    </header>
  );
};
