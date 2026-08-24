import React, { useEffect, useRef, useState } from 'react';
import { AgentChatMessage, MoLRouteResult, ToastMessage, User } from '../types';
import { UI4AReplHarness } from './UI4AReplHarness';
import { ResourceMonitor } from './ResourceMonitor';
import { api, ApiError } from '../lib/api';
import { preloadCompiler } from '../lib/compileArtifact';
import {
  Terminal,
  Send,
  Cpu,
  Sparkles,
  Bot,
  RefreshCw,
  Camera,
  Download,
  FileJson,
  X,
  Copy,
  Check,
  Lock,
} from 'lucide-react';

interface CommandCenterProps {
  addToast?: (toast: Omit<ToastMessage, 'id' | 'timestamp'>) => void;
  user: User | null;
  onOpenAuth: () => void;
}

export const CommandCenter: React.FC<CommandCenterProps> = ({ addToast, user, onOpenAuth }) => {
  const [messages, setMessages] = useState<AgentChatMessage[]>([
    {
      id: 'msg-1',
      sender: 'system',
      text: 'V12 Apex Atlas: Macaron-v1 LO routing gate online. Queries are scored against four specialist rule sets and dispatched to the strongest; the model call itself goes to Gemini. Zero-loss constraint (Δπ > 0) is enforced server-side, in code, not by the model.',
      timestamp: new Date().toLocaleTimeString(),
    },
    {
      id: 'msg-2',
      sender: 'agent',
      specialist: 'chat',
      text: 'Welcome to Central Command. Ask any question, dispatch workflow tasks, or request dynamic visual artifacts (GenUI). The router picks a specialist profile for your request and shows you why it chose it.',
      timestamp: new Date().toLocaleTimeString(),
    },
  ]);
  const [inputQuery, setInputQuery] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentRoute, setCurrentRoute] = useState<MoLRouteResult | null>({
    query: 'System Ready',
    selectedSpecialist: 'chat',
    routingWeights: [0.60, 0.20, 0.10, 0.10],
    allocationTrace: { chat: 0.60, personal_agent: 0.20, genui: 0.10, coding: 0.10 },
    latencyMs: 14,
    explanation: 'LO Routing Gate ready for incoming stream.',
  });

  const [isSnapshotModalOpen, setIsSnapshotModalOpen] = useState(false);
  const [snapshotJsonString, setSnapshotJsonString] = useState('');
  const [isCopied, setIsCopied] = useState(false);

  const streamEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // New messages used to land below the fold with no indication anything had
  // happened; the operator had to scroll manually after every dispatch.
  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isProcessing]);

  // Warm the JSX transpiler so the first GenUI artifact renders without a
  // visible download pause.
  useEffect(() => {
    preloadCompiler();
  }, []);

  const generateSnapshotData = () => {
    const snapshot = {
      workspace: 'V12 Apex Atlas Enterprise Digital Twin Workspace',
      version: __APP_VERSION__,
      capturedAt: new Date().toISOString(),
      loRoutingSubstrate: {
        model: 'GLM-5.2 + MoL (Mixture of LoRAs)',
        activeSpecialist: currentRoute?.selectedSpecialist || 'chat',
        routingWeights: currentRoute?.routingWeights || [],
        allocationTrace: currentRoute?.allocationTrace || {},
        lastLatencyMs: currentRoute?.latencyMs || 0,
        explanation: currentRoute?.explanation || '',
      },
      terminalState: {
        totalMessages: messages.length,
        messages: messages.map((m) => ({
          id: m.id,
          sender: m.sender,
          specialist: m.specialist || null,
          timestamp: m.timestamp,
          textPreview: m.text.length > 120 ? `${m.text.substring(0, 120)}...` : m.text,
          hasArtifact: !!m.artifact,
        })),
      },
      activeArtifact: messages.find((m) => m.artifact)?.artifact || null,
      securityCompliance: {
        autoLogoutEnabled: true,
        inactivityTimeoutMinutes: 15,
        fiduciaryRule: 'Δπ > $0.00',
        syncTargetLatencyMs: 45,
      },
    };
    return snapshot;
  };

  const handleTakeSnapshot = () => {
    const snapshot = generateSnapshotData();
    const jsonStr = JSON.stringify(snapshot, null, 2);
    setSnapshotJsonString(jsonStr);

    // Trigger local JSON file download
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `v12_apex_atlas_snapshot_${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);

    setIsSnapshotModalOpen(true);

    if (addToast) {
      addToast({
        type: 'success',
        title: 'WORKSPACE SNAPSHOT CAPTURED',
        description: 'Captured current UI state & active module configuration as JSON blob. Download initiated.',
        duration: 5000,
      });
    }
  };

  const handleCopySnapshot = () => {
    navigator.clipboard.writeText(snapshotJsonString);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const newId = (prefix: string) =>
    `${prefix}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;

  const handleSend = async (customPrompt?: string) => {
    const queryText = (customPrompt || inputQuery).trim();
    if (!queryText || isProcessing) return;

    if (!user) {
      addToast?.({
        type: 'warning',
        title: 'Sign in required',
        description: 'Model endpoints are authenticated so the workspace API key cannot be used anonymously.',
      });
      onOpenAuth();
      return;
    }

    const userMsg: AgentChatMessage = {
      id: newId('usr'),
      sender: 'user',
      text: queryText,
      timestamp: new Date().toLocaleTimeString(),
    };

    // Capture history before appending so we send the prior turns, not this one.
    const history = messages
      .filter((m) => m.sender === 'user' || m.sender === 'agent')
      .slice(-12)
      .map((m) => ({ sender: m.sender, text: m.text }));

    setMessages((prev) => [...prev, userMsg]);
    if (!customPrompt) setInputQuery('');
    setIsProcessing(true);

    try {
      const routeData = await api.post<MoLRouteResult>('/api/mol-router', { query: queryText });
      setCurrentRoute(routeData);

      if (routeData.selectedSpecialist === 'genui') {
        const genui = await api.post<{ code: string; propsData: unknown; source?: string; reason?: string }>(
          '/api/gemini/genui',
          { prompt: queryText },
        );

        if (genui.source === 'fallback' && genui.reason) {
          addToast?.({
            type: 'warning',
            title: 'Rendered a local template',
            description: genui.reason,
          });
        }

        setMessages((prev) => [
          ...prev,
          {
            id: newId('agt'),
            sender: 'agent',
            specialist: 'genui',
            text:
              genui.source === 'fallback'
                ? 'The model was unavailable, so a local placeholder component was compiled instead.'
                : 'Routed to the GenUI adapter. The synthesised component is compiled and rendered below.',
            timestamp: new Date().toLocaleTimeString(),
            routingResult: routeData,
            artifact: {
              code: genui.code,
              propsData: genui.propsData,
              title: queryText,
            },
          },
        ]);
      } else {
        // History is now actually sent, so the assistant has continuity.
        const chat = await api.post<{ reply: string }>('/api/gemini/chat', {
          message: queryText,
          history,
        });

        setMessages((prev) => [
          ...prev,
          {
            id: newId('agt'),
            sender: 'agent',
            specialist: routeData.selectedSpecialist,
            text: chat.reply,
            timestamp: new Date().toLocaleTimeString(),
            routingResult: routeData,
          },
        ]);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Request failed.';
      if (err instanceof ApiError && err.status === 401) onOpenAuth();

      setMessages((prev) => [
        ...prev,
        {
          id: newId('err'),
          sender: 'system',
          text: `Request failed: ${message}`,
          timestamp: new Date().toLocaleTimeString(),
        },
      ]);
      addToast?.({ type: 'error', title: 'Dispatch failed', description: message });
    } finally {
      setIsProcessing(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto font-mono text-zinc-100 bg-zinc-950">
      {/* Top Banner: LO Routing Substrate Status */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="lg:col-span-3 bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 shadow-xl backdrop-blur-md">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
            <div className="flex items-center space-x-2">
              <Cpu className="w-5 h-5 text-emerald-400" />
              <h2 className="text-sm font-bold text-zinc-100">LO ROUTING AGENT (Local-Optima Substrate)</h2>
            </div>
            <div className="flex items-center space-x-2">
              <button
                onClick={handleTakeSnapshot}
                className="flex items-center space-x-1.5 px-3 py-1 rounded-lg bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-500/40 text-emerald-300 text-xs font-mono font-bold transition-all cursor-pointer shadow-sm"
                title="Capture current UI state and active module data as a JSON blob"
              >
                <Camera className="w-3.5 h-3.5 text-emerald-400" />
                <span>Save Snapshot (JSON)</span>
              </button>
              <span className="text-xs px-2.5 py-1 rounded bg-zinc-950 text-emerald-400 border border-emerald-500/30 font-mono">
                Routing gate · heuristic
              </span>
            </div>
          </div>

          <p className="text-xs text-zinc-400 mb-4 font-sans">
            Scores each query by term match against four specialist rule sets and dispatches to the
            strongest: <span className="text-emerald-400 font-mono">Chat</span>, <span className="text-cyan-400 font-mono">Personal Agent</span>, <span className="text-purple-400 font-mono">GenUI</span>, and <span className="text-amber-400 font-mono font-semibold">Coding</span>. The weights below are the fixed
            profile of the selected specialist, not a learned blend — the Mixture-of-LoRAs substrate in the
            specification is not what is running.
          </p>

          {/* Allocation Weights Bar Chart */}
          {currentRoute && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>Active Routing Profile: <strong className="text-emerald-400 uppercase">{currentRoute.selectedSpecialist} SPECIALIST</strong></span>
                <span>Latency: {currentRoute.latencyMs}ms</span>
              </div>
              <div className="grid grid-cols-4 gap-2 text-center text-[11px]">
                <div className={`p-2 rounded-lg border transition-all ${currentRoute.selectedSpecialist === 'chat' ? 'bg-emerald-950/80 border-emerald-500 text-emerald-300' : 'bg-zinc-950 border-zinc-800 text-zinc-400'}`}>
                  <div className="text-[10px] text-zinc-500">CHAT LORA</div>
                  <div className="font-bold text-sm">{(currentRoute.allocationTrace.chat * 100).toFixed(0)}%</div>
                </div>
                <div className={`p-2 rounded-lg border transition-all ${currentRoute.selectedSpecialist === 'personal_agent' ? 'bg-cyan-950/80 border-cyan-500 text-cyan-300' : 'bg-zinc-950 border-zinc-800 text-zinc-400'}`}>
                  <div className="text-[10px] text-zinc-500 font-semibold">PERSONAL LORA</div>
                  <div className="font-bold text-sm">{(currentRoute.allocationTrace.personal_agent * 100).toFixed(0)}%</div>
                </div>
                <div className={`p-2 rounded-lg border transition-all ${currentRoute.selectedSpecialist === 'genui' ? 'bg-purple-950/80 border-purple-500 text-purple-300' : 'bg-zinc-950 border-zinc-800 text-zinc-400'}`}>
                  <div className="text-[10px] text-zinc-500">GENUI LORA</div>
                  <div className="font-bold text-sm">{(currentRoute.allocationTrace.genui * 100).toFixed(0)}%</div>
                </div>
                <div className={`p-2 rounded-lg border transition-all ${currentRoute.selectedSpecialist === 'coding' ? 'bg-amber-950/80 border-amber-500 text-amber-300' : 'bg-zinc-950 border-zinc-800 text-zinc-400'}`}>
                  <div className="text-[10px] text-zinc-500">CODE LORA</div>
                  <div className="font-bold text-sm">{(currentRoute.allocationTrace.coding * 100).toFixed(0)}%</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Quick Action Presets */}
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="text-xs font-bold text-zinc-200 mb-2 flex items-center space-x-1.5">
              <Sparkles className="w-4 h-4 text-purple-400" />
              <span>TEST ROUTER PRESETS</span>
            </div>
            <div className="space-y-1.5 text-xs">
              <button
                onClick={() => handleSend('Generate a UI widget for real-time H.266 video render throughput')}
                className="w-full text-left p-2 rounded bg-zinc-950 border border-purple-500/30 hover:bg-purple-950/30 text-purple-300 transition-colors text-[11px] truncate cursor-pointer"
              >
                ✨ GenUI: Video Render Widget
              </button>
              <button
                onClick={() => handleSend('Evaluate Hermes zero-loss arbitrage for H266 NFT AST-H266-001')}
                className="w-full text-left p-2 rounded bg-zinc-950 border border-cyan-500/30 hover:bg-cyan-950/30 text-cyan-300 transition-colors text-[11px] truncate cursor-pointer"
              >
                💼 Personal Agent: Arbitrage Check
              </button>
              <button
                onClick={() => handleSend('Write Python code for PyTorch MoLLayer adapter forward pass')}
                className="w-full text-left p-2 rounded bg-zinc-950 border border-amber-500/30 hover:bg-amber-950/30 text-amber-300 transition-colors text-[11px] truncate cursor-pointer"
              >
                ⚡ Coding: MoL Router Neural Script
              </button>
            </div>
          </div>
          <div className="mt-3 text-[10px] text-zinc-500 text-center">
            Click any preset to trigger MoL route dispatch.
          </div>
        </div>
      </div>

      {/* Real-time D3 System Resource Monitor */}
      <ResourceMonitor />

      {/* Main Terminal & Conversation Stream */}
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 md:p-5 shadow-2xl flex flex-col h-[520px]">
        <div className="flex items-center justify-between pb-3 mb-3 border-b border-zinc-800">
          <div className="flex items-center space-x-2">
            <Terminal className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-bold text-zinc-200">MACARON-V1 TERMINAL STREAM</span>
          </div>
          <div className="flex items-center space-x-2 text-[10px] text-zinc-400">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>REPL Execution Harness Ready</span>
          </div>
        </div>

        {/* Messages Scroll Area */}
        <div className="flex-1 overflow-y-auto space-y-4 pr-2">
          {messages.map((msg) => (
            <div key={msg.id} className="space-y-2">
              <div
                className={`p-3 rounded-xl border text-xs leading-relaxed ${
                  msg.sender === 'user'
                    ? 'bg-zinc-800/80 border-zinc-700 text-zinc-100 ml-auto max-w-[85%]'
                    : msg.sender === 'system'
                    ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
                    : 'bg-zinc-950 border-zinc-800 text-zinc-200 mr-auto w-full'
                }`}
              >
                <div className="flex items-center justify-between text-[10px] text-zinc-500 mb-1 font-mono">
                  <div className="flex items-center space-x-1.5">
                    {msg.sender === 'user' ? (
                      <span className="text-zinc-300 font-bold">▶ DEVELOPER</span>
                    ) : msg.sender === 'system' ? (
                      <span className="text-emerald-400 font-bold">⚙ SYSTEM CORE</span>
                    ) : (
                      <span className="text-cyan-400 font-bold uppercase flex items-center space-x-1">
                        <Bot className="w-3 h-3" />
                        <span>{msg.specialist?.toUpperCase() || 'AGENT'}</span>
                      </span>
                    )}
                  </div>
                  <span>{msg.timestamp}</span>
                </div>

                <div className="font-sans whitespace-pre-wrap">{msg.text}</div>

                {/* Optional Routing Trace Badge */}
                {msg.routingResult && (
                  <div className="mt-2 text-[10px] font-mono text-zinc-400 pt-2 border-t border-zinc-800/60 flex items-center justify-between">
                    <span>Route: <span className="text-emerald-400">{msg.routingResult.explanation}</span></span>
                    <span>{msg.routingResult.latencyMs}ms</span>
                  </div>
                )}
              </div>

              {/* Dynamic UI4A REPL Harness Artifact rendering */}
              {msg.artifact && (
                <div className="my-3 pl-4 border-l-2 border-purple-500">
                  <UI4AReplHarness
                    code={msg.artifact.code}
                    propsData={msg.artifact.propsData}
                    title={msg.artifact.title}
                  />
                </div>
              )}
            </div>
          ))}

          {isProcessing && (
            <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-zinc-400 flex items-center space-x-3">
              <RefreshCw className="w-4 h-4 text-emerald-400 animate-spin" aria-hidden="true" />
              <span>Routing the query and compiling the response…</span>
            </div>
          )}

          {/* Scroll anchor */}
          <div ref={streamEndRef} />
        </div>

        {/* Input Bar */}
        <div className="mt-4 pt-3 border-t border-zinc-800 flex items-center space-x-2">
          <label htmlFor="command-input" className="sr-only">
            Query or command
          </label>
          <input
            id="command-input"
            ref={inputRef}
            type="text"
            value={inputQuery}
            disabled={isProcessing}
            onChange={(e) => setInputQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSend();
            }}
            placeholder={
              user
                ? "Ask a question or request a component (e.g. 'Build a GPU monitor widget')…"
                : 'Sign in to dispatch queries…'
            }
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500 font-sans disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={isProcessing || !inputQuery.trim()}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:cursor-not-allowed text-white rounded-lg text-xs font-mono font-bold flex items-center space-x-1.5 transition-colors cursor-pointer"
          >
            <span>{user ? 'Dispatch' : 'Sign in'}</span>
            {user ? (
              <Send className="w-3.5 h-3.5" aria-hidden="true" />
            ) : (
              <Lock className="w-3.5 h-3.5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Snapshot Modal */}
      {isSnapshotModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Workspace snapshot"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setIsSnapshotModalOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setIsSnapshotModalOpen(false);
          }}
          tabIndex={-1}
          ref={(el) => el?.focus()}
        >
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-3xl w-full p-5 shadow-2xl flex flex-col space-y-4 text-zinc-100">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center space-x-2">
                <FileJson className="w-5 h-5 text-emerald-400" />
                <h3 className="text-sm font-bold text-zinc-100">
                  WORKSPACE CONFIGURATION SNAPSHOT (JSON)
                </h3>
              </div>
              <button
                onClick={() => setIsSnapshotModalOpen(false)}
                className="text-zinc-500 hover:text-zinc-200 p-1 rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-zinc-400 font-sans">
              Snapshot successfully exported to your downloads folder. Below is the captured JSON state containing active MoL weights, terminal stream history, and module configuration.
            </p>

            <div className="relative bg-zinc-950 p-4 rounded-xl border border-zinc-800 max-h-96 overflow-y-auto">
              <pre className="text-[11px] font-mono text-emerald-300 leading-relaxed whitespace-pre-wrap">
                {snapshotJsonString}
              </pre>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-zinc-800 text-xs">
              <span className="text-zinc-500 text-[10px]">
                Captured: {new Date().toLocaleString()}
              </span>
              <div className="flex items-center space-x-3">
                <button
                  onClick={handleCopySnapshot}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 font-bold transition-colors cursor-pointer"
                >
                  {isCopied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-400">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy JSON</span>
                    </>
                  )}
                </button>
                <button
                  onClick={handleTakeSnapshot}
                  className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold transition-colors cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Re-Download JSON</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
