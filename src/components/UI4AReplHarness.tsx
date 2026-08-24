/**
 * UI4A Execution REPL Harness.
 *
 * Transpiles here, executes nowhere: the compiled source goes to
 * `SandboxedArtifact`, which owns execution inside an opaque-origin iframe.
 */

import React, { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { ArtifactProps } from '../types';
import { transpileArtifact, ArtifactCompileError } from '../lib/compileArtifact';
import { SandboxedArtifact } from './SandboxedArtifact';

type CompileState =
  | { status: 'idle' }
  | { status: 'compiling' }
  | { status: 'ready'; compiled: string }
  | { status: 'error'; message: string; phase: string };

export const UI4AReplHarness: React.FC<ArtifactProps> = ({ code, propsData, title }) => {
  const [state, setState] = useState<CompileState>({ status: 'idle' });

  useEffect(() => {
    if (!code?.trim()) {
      setState({ status: 'idle' });
      return;
    }

    let cancelled = false;
    setState({ status: 'compiling' });

    transpileArtifact(code)
      .then((compiled) => {
        if (!cancelled) setState({ status: 'ready', compiled });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
          phase: err instanceof ArtifactCompileError ? err.phase : 'unknown',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  return (
    <div className="border border-zinc-800 bg-zinc-950/90 rounded-xl p-5 shadow-2xl relative overflow-hidden backdrop-blur-md">
      <div className="absolute top-2.5 right-3 flex items-center space-x-1.5 z-10">
        <span
          className={`w-2 h-2 rounded-full ${
            state.status === 'ready'
              ? 'bg-emerald-500'
              : state.status === 'error'
                ? 'bg-red-500'
                : 'bg-amber-500 animate-pulse'
          }`}
          aria-hidden="true"
        />
        <span className="text-[10px] text-zinc-400 font-mono tracking-wider">EXEC HARNESS</span>
      </div>

      {title && (
        <div className="text-xs font-semibold text-zinc-300 font-mono mb-3 pb-2 border-b border-zinc-800/80 flex items-center space-x-2 pr-32">
          <span className="text-emerald-400" aria-hidden="true">
            ❖
          </span>
          <span className="truncate">{title}</span>
        </div>
      )}

      {state.status === 'idle' && (
        <div className="text-zinc-500 font-mono text-xs py-4 text-center">
          No component source yet. Compile one to see it render here.
        </div>
      )}

      {state.status === 'compiling' && (
        <div className="text-zinc-400 font-mono text-xs py-4 flex items-center space-x-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" aria-hidden="true" />
          <span>Transpiling JSX…</span>
        </div>
      )}

      {state.status === 'error' && (
        <div
          role="alert"
          className="p-4 bg-red-950/70 border border-red-600/60 text-red-100 rounded-lg font-mono text-xs space-y-2"
        >
          <div className="flex items-center space-x-2 font-bold text-red-300">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Compilation failed ({state.phase})</span>
          </div>
          <pre className="whitespace-pre-wrap break-words leading-relaxed text-red-100/90">{state.message}</pre>
        </div>
      )}

      {state.status === 'ready' && <SandboxedArtifact code={state.compiled} propsData={propsData} />}
    </div>
  );
};
