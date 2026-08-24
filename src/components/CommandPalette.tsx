import React, { useState, useEffect, useRef } from 'react';
import { ActiveTab } from './Sidebar';
import {
  Search,
  Terminal,
  TrendingUp,
  Globe2,
  Code2,
  Activity,
  Shield,
  Key,
  Zap,
  Lock,
  RefreshCw,
  Sparkles,
  WifiOff,
  CornerDownLeft,
  X,
  ShieldAlert,
  ScrollText,
  Gauge,
} from 'lucide-react';

export interface CommandItem {
  id: string;
  category: 'Navigation' | 'Security & Governance' | 'Synchronizer & Alerts' | 'Operations';
  label: string;
  detail: string;
  icon: React.ElementType;
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  setActiveTab: (tab: ActiveTab) => void;
  onOpenAuth: () => void;
  onLogout: () => void;
  onSimulateLatencySpike: () => void;
  onSimulateConnectionDrop: () => void;
  onTriggerAutoLogoutTest: () => void;
  onReindexMemory: () => void;
  onEvaluateHermes: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  setActiveTab,
  onOpenAuth,
  onLogout,
  onSimulateLatencySpike,
  onSimulateConnectionDrop,
  onTriggerAutoLogoutTest,
  onReindexMemory,
  onEvaluateHermes,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const commands: CommandItem[] = [
    // Navigation
    {
      id: 'nav-command',
      category: 'Navigation',
      label: 'AI Command Center',
      detail: 'MoL Router & GLM-5.2 Specialist Dispatcher',
      icon: Terminal,
      shortcut: 'Tab 1',
      action: () => {
        setActiveTab('command_center');
        onClose();
      },
    },
    {
      id: 'nav-revenue',
      category: 'Navigation',
      label: 'Revenue Boardroom',
      detail: 'Hermes Zero-Loss Arbitrage (Δπ > $0)',
      icon: TrendingUp,
      shortcut: 'Tab 2',
      action: () => {
        setActiveTab('revenue_boardroom');
        onClose();
      },
    },
    {
      id: 'nav-execution',
      category: 'Navigation',
      label: 'Asset Ledger',
      detail: 'Live quotes, positions, working orders and the kill switch',
      icon: Gauge,
      action: () => {
        setActiveTab('execution_desk');
        onClose();
      },
    },
    {
      id: 'nav-memory',
      category: 'Navigation',
      label: 'Memory Galaxy Vault',
      detail: 'Obsidian Digital Twin Knowledge Graph',
      icon: Globe2,
      shortcut: 'Tab 3',
      action: () => {
        setActiveTab('memory_galaxy');
        onClose();
      },
    },
    {
      id: 'nav-repl',
      category: 'Navigation',
      label: 'UI4A REPL Harness',
      detail: 'React 19 GenUI Component Compiler',
      icon: Code2,
      shortcut: 'Tab 4',
      action: () => {
        setActiveTab('repl_harness');
        onClose();
      },
    },
    {
      id: 'nav-sync',
      category: 'Navigation',
      label: '45ms Synchronizer',
      detail: 'Real-time Telemetry & Replication Loop',
      icon: Activity,
      shortcut: 'Tab 5',
      action: () => {
        setActiveTab('synchronizer');
        onClose();
      },
    },
    {
      id: 'nav-security',
      category: 'Navigation',
      label: 'Security & Auth Shield',
      detail: 'JWT Bearer & Role-Based Access Controls',
      icon: Shield,
      shortcut: 'Tab 6',
      action: () => {
        setActiveTab('security_auth');
        onClose();
      },
    },

    {
      id: 'nav-audit',
      category: 'Navigation',
      label: 'Decision Audit Log',
      detail: 'Hash-chained record of every execution decision, including refusals',
      icon: ScrollText,
      shortcut: 'Tab 7',
      action: () => {
        setActiveTab('audit_log');
        onClose();
      },
    },

    // Security & Governance
    {
      id: 'sec-auth',
      category: 'Security & Governance',
      label: 'Authenticate JWT Credentials',
      detail: 'Open Enterprise Sign-In & Role Register Modal',
      icon: Key,
      action: () => {
        onOpenAuth();
        onClose();
      },
    },
    {
      id: 'sec-autologout-test',
      category: 'Security & Governance',
      label: 'Trigger Inactivity Auto-Logout Test',
      detail: 'Simulate 15-minute compliance security session termination',
      icon: ShieldAlert,
      action: () => {
        onTriggerAutoLogoutTest();
        onClose();
      },
    },
    {
      id: 'sec-logout',
      category: 'Security & Governance',
      label: 'Sign Out Current Session',
      detail: 'Clear local JWT token and restrict access',
      icon: Lock,
      action: () => {
        onLogout();
        onClose();
      },
    },

    // Synchronizer & Alerts
    {
      id: 'sync-latency-spike',
      category: 'Synchronizer & Alerts',
      label: 'Simulate Sync Latency Spike',
      detail: 'Trigger real-time 345ms delay alert & re-routing toast notification',
      icon: Zap,
      shortcut: 'Alert',
      action: () => {
        onSimulateLatencySpike();
        onClose();
      },
    },
    {
      id: 'sync-connection-drop',
      category: 'Synchronizer & Alerts',
      label: 'Simulate Connection Interruption',
      detail: 'Emit real-time network websocket reconnect alert toast',
      icon: WifiOff,
      action: () => {
        onSimulateConnectionDrop();
        onClose();
      },
    },

    // Operations
    {
      id: 'op-hermes-eval',
      category: 'Operations',
      label: 'Execute Hermes Arbitrage Evaluation',
      detail: 'Scan video asset holdings for Δπ > $0 guaranteed strike offers',
      icon: Sparkles,
      action: () => {
        setActiveTab('revenue_boardroom');
        onEvaluateHermes();
        onClose();
      },
    },
    {
      id: 'op-reindex-memory',
      category: 'Operations',
      label: 'Re-index Memory Galaxy Vault',
      detail: 'Re-parse vault frontmatter and re-run the structural validator',
      icon: RefreshCw,
      action: () => {
        onReindexMemory();
        onClose();
      },
    },
  ];

  const filteredCommands = commands.filter(
    (cmd) =>
      cmd.label.toLowerCase().includes(query.toLowerCase()) ||
      cmd.detail.toLowerCase().includes(query.toLowerCase()) ||
      cmd.category.toLowerCase().includes(query.toLowerCase())
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, filteredCommands.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) =>
        prev === 0 ? filteredCommands.length - 1 : prev - 1
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredCommands[selectedIndex]) {
        filteredCommands[selectedIndex].action();
      }
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 sm:pt-24 bg-black/80 backdrop-blur-md p-4 font-mono"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-zinc-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Bar */}
        <div className="p-4 border-b border-zinc-800 flex items-center space-x-3 bg-zinc-950">
          <Search className="w-5 h-5 text-emerald-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search workspace tabs (Cmd+K)..."
            className="flex-1 bg-transparent border-none text-sm text-zinc-100 focus:outline-none placeholder-zinc-500 font-mono"
          />
          <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-400 font-bold">
            ESC to close
          </span>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 p-1 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Command List */}
        <div className="max-h-96 overflow-y-auto p-2 space-y-1">
          {filteredCommands.length === 0 ? (
            <div className="p-8 text-center text-xs text-zinc-500 font-sans">
              No matching commands found for "{query}"
            </div>
          ) : (
            filteredCommands.map((cmd, idx) => {
              const Icon = cmd.icon;
              const isSelected = idx === selectedIndex;

              return (
                <button
                  key={cmd.id}
                  onClick={cmd.action}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`w-full text-left p-3 rounded-xl transition-all flex items-center justify-between cursor-pointer border ${
                    isSelected
                      ? 'bg-zinc-800/90 border-emerald-500/50 text-emerald-300'
                      : 'bg-transparent border-transparent text-zinc-300 hover:bg-zinc-800/40'
                  }`}
                >
                  <div className="flex items-center space-x-3 min-w-0">
                    <div
                      className={`p-2 rounded-lg border ${
                        isSelected
                          ? 'bg-emerald-950 border-emerald-500/40 text-emerald-400'
                          : 'bg-zinc-950 border-zinc-800 text-zinc-400'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center space-x-2">
                        <span className="text-xs font-bold truncate">{cmd.label}</span>
                        <span className="text-[9px] px-1.5 py-0.2 rounded bg-zinc-950 text-zinc-500 border border-zinc-800">
                          {cmd.category}
                        </span>
                      </div>
                      <div className="text-[11px] text-zinc-400 font-sans truncate mt-0.5">
                        {cmd.detail}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center space-x-2 shrink-0 ml-3">
                    {cmd.shortcut && (
                      <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-950 text-zinc-400 border border-zinc-800">
                        {cmd.shortcut}
                      </span>
                    )}
                    {isSelected && <CornerDownLeft className="w-4 h-4 text-emerald-400" />}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Command Palette Footer */}
        <div className="p-3 bg-zinc-950 border-t border-zinc-800 flex items-center justify-between text-[10px] text-zinc-500 font-mono">
          <div className="flex items-center space-x-3">
            <span><kbd className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-300">↑↓</kbd> Navigate</span>
            <span><kbd className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-300">↵</kbd> Select</span>
          </div>
          <div className="text-emerald-400 font-bold">V12 APEX ATLAS GLOBAL PALETTE</div>
        </div>
      </div>
    </div>
  );
};
