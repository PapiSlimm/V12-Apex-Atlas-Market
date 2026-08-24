import React, { useEffect, useState } from 'react';
import { UI4AReplHarness } from './UI4AReplHarness';
import { Code2, Sparkles, Play, Copy, Check, RefreshCw, AlertTriangle, Lock } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { useTheme } from '../context/ThemeContext';
import { api, ApiError } from '../lib/api';
import { preloadCompiler } from '../lib/compileArtifact';
import { User } from '../types';

interface UI4AReplSandboxProps {
  user: User | null;
  onOpenAuth: () => void;
}

export const UI4AReplSandbox: React.FC<UI4AReplSandboxProps> = ({ user, onOpenAuth }) => {
  const { t } = useLanguage();
  const { isHighContrast } = useTheme();
  const [prompt, setPrompt] = useState('Create a real-time GPU compute throughput gauge widget with status lights.');
  const [code, setCode] = useState(`return (
  <div className="p-4 bg-zinc-900 border border-emerald-500/40 rounded-xl text-zinc-100 shadow-xl font-mono">
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center space-x-2">
        <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-xs font-bold text-emerald-400 uppercase tracking-wide">V12 GENUI REPL VECTOR</span>
      </div>
      <span className="text-[10px] text-zinc-500">React 19 Harness</span>
    </div>
    <div className="grid grid-cols-2 gap-3 text-center text-xs">
      <div className="bg-zinc-950 p-3 rounded-lg border border-zinc-800">
        <div className="text-zinc-500 text-[10px]">FPS RENDER LINE</div>
        <div className="text-lg font-bold text-emerald-400 mt-1">24,000 FPS</div>
      </div>
      <div className="bg-zinc-950 p-3 rounded-lg border border-zinc-800">
        <div className="text-zinc-500 text-[10px]">FIDUCIARY STATE</div>
        <div className="text-lg font-bold text-amber-400 mt-1">Δπ &gt; $0.00</div>
      </div>
    </div>
  </div>
);`);
  const [propsData, setPropsData] = useState({
    title: 'Baseline GenUI Artifact',
    timestamp: new Date().toLocaleTimeString(),
  });
  const [isGenerating, setIsGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    preloadCompiler();
  }, []);

  const handleGenerate = async () => {
    if (!prompt.trim() || isGenerating) return;
    if (!user) {
      onOpenAuth();
      return;
    }

    setIsGenerating(true);
    setError(null);
    try {
      const data = await api.post<{ code: string; propsData: any; source?: string; reason?: string }>(
        '/api/gemini/genui',
        { prompt },
      );
      setCode(data.code);
      setPropsData(data.propsData);
      if (data.source === 'fallback' && data.reason) {
        setError(`Model unavailable — rendered a local template instead. (${data.reason})`);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onOpenAuth();
      // Errors used to vanish into console.error; the operator saw a spinner
      // stop and nothing else.
      setError(err instanceof Error ? err.message : 'Generation failed.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Clipboard access was denied by the browser.');
    }
  };

  return (
    <div className={`flex-1 p-4 md:p-6 space-y-6 overflow-y-auto font-mono transition-all ${
      isHighContrast ? 'bg-black text-white' : 'bg-zinc-950 text-zinc-100'
    }`}>
      {/* Sandbox Header */}
      <div className={`p-5 rounded-xl border backdrop-blur-md shadow-xl ${
        isHighContrast ? 'bg-black border-2 border-white text-white' : 'bg-zinc-900/90 border-zinc-800'
      }`}>
        <div className="flex items-center space-x-3 mb-2">
          <div className={`p-2 rounded-lg border ${
            isHighContrast ? 'bg-white text-black border-white' : 'bg-purple-950 border-purple-500/40 text-purple-400'
          }`}>
            <Code2 className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-base font-bold">{t('replTitle')}</h2>
            <p className={`text-xs font-sans ${isHighContrast ? 'text-zinc-300' : 'text-zinc-400'}`}>
              {t('replDesc')}
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Prompt Bar & Code Vector Editor */}
        <div className="space-y-4">
          <div className={`p-4 rounded-xl border shadow-xl space-y-3 ${
            isHighContrast ? 'bg-black border-2 border-white' : 'bg-zinc-900/90 border-zinc-800'
          }`}>
            <label className="text-xs font-bold uppercase tracking-wide flex items-center space-x-2">
              <Sparkles className="w-4 h-4 text-purple-400" />
              <span>Prompt GLM-5.2 GenUI Specialist</span>
            </label>

            {error && (
              <div
                role="alert"
                className="p-2.5 rounded-lg bg-amber-950/60 border border-amber-500/50 text-amber-200 text-[11px] font-sans flex items-start space-x-2"
              >
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex items-center space-x-2">
              <input
                type="text"
                aria-label="Component prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleGenerate();
                }}
                placeholder={t('promptPlaceholder')}
                className={`flex-1 rounded-lg px-3.5 py-2 text-xs focus:outline-none font-sans border ${
                  isHighContrast ? 'bg-black border-white text-white focus:border-yellow-400' : 'bg-zinc-950 border-zinc-800 text-zinc-100 focus:border-purple-500'
                }`}
              />
              <button
                type="button"
                onClick={() => void handleGenerate()}
                disabled={isGenerating}
                className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center space-x-1.5 transition-colors cursor-pointer border ${
                  isHighContrast
                    ? 'bg-yellow-400 text-black font-extrabold border-white hover:bg-yellow-300'
                    : 'bg-purple-600 hover:bg-purple-500 disabled:bg-zinc-800 text-white border-transparent'
                }`}
              >
                {isGenerating ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Compiling...</span>
                  </>
                ) : user ? (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
                    <span>{t('compileGenUI')}</span>
                  </>
                ) : (
                  <>
                    <Lock className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Sign in</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <div className={`p-4 rounded-xl border shadow-xl flex flex-col h-[400px] ${
            isHighContrast ? 'bg-black border-2 border-white' : 'bg-zinc-900/90 border-zinc-800'
          }`}>
            <div className="flex items-center justify-between pb-2 mb-2 border-b border-zinc-800">
              <span className="text-xs font-bold text-zinc-300">{t('jsxSourceEditor')}</span>
              <button
                type="button"
                onClick={() => void handleCopy()}
                className="text-[10px] text-zinc-400 hover:text-zinc-200 flex items-center space-x-1 cursor-pointer"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                ) : (
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>{copied ? t('copied') : t('copyCode')}</span>
              </button>
            </div>

            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              aria-label={t('jsxSourceEditor')}
              spellCheck={false}
              className={`flex-1 w-full rounded-xl p-3.5 text-xs font-mono focus:outline-none resize-none leading-relaxed border ${
                isHighContrast
                  ? 'bg-black text-yellow-300 border-white focus:border-yellow-400'
                  : 'bg-zinc-950 text-purple-300 border-zinc-800 focus:border-purple-500'
              }`}
            />
          </div>
        </div>

        {/* Right: Live Sandboxed REPL Harness Output */}
        <div className="space-y-4">
          <div className={`p-4 rounded-xl border shadow-xl ${
            isHighContrast ? 'bg-black border-2 border-white' : 'bg-zinc-900/90 border-zinc-800'
          }`}>
            <h3 className="text-xs font-bold uppercase tracking-wide mb-3 flex items-center space-x-2">
              <Play className="w-4 h-4 text-emerald-400" />
              <span>{t('livePreviewHarness')}</span>
            </h3>

            <UI4AReplHarness code={code} propsData={propsData} title={`Sandbox Artifact: ${prompt}`} />
          </div>
        </div>
      </div>
    </div>
  );
};
