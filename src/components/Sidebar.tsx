import React from 'react';
import {
  Gauge,
  ScrollText,
  Terminal,
  TrendingUp,
  Globe2,
  Code2,
  Activity,
  Shield,
  Layers,
  ChevronRight,
} from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { useTheme } from '../context/ThemeContext';

export type ActiveTab =
  | 'command_center'
  | 'revenue_boardroom'
  | 'memory_galaxy'
  | 'repl_harness'
  | 'synchronizer'
  | 'security_auth'
  | 'audit_log'
  | 'execution_desk';

interface SidebarProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab }) => {
  const { t } = useLanguage();
  const { isHighContrast } = useTheme();

  const menuItems = [
    {
      id: 'command_center' as ActiveTab,
      label: t('commandCenter'),
      sub: 'MoL LO Router & Agents',
      icon: Terminal,
      badge: 'Routing',
    },
    {
      id: 'revenue_boardroom' as ActiveTab,
      label: t('revenueBoardroom'),
      sub: 'Hermes Arbitrage (Δπ > 0)',
      icon: TrendingUp,
      badge: 'Δπ>0',
    },
    {
      id: 'execution_desk' as ActiveTab,
      label: t('executionDesk'),
      sub: 'Media blocks, fills & positions',
      icon: Gauge,
      badge: 'Blocks',
    },
    {
      id: 'memory_galaxy' as ActiveTab,
      label: t('memoryGalaxy'),
      sub: 'Obsidian Digital Twin Graph',
      icon: Globe2,
      badge: 'Obsidian',
    },
    {
      id: 'repl_harness' as ActiveTab,
      label: t('replHarness'),
      sub: 'Dynamic GenUI Sandbox',
      icon: Code2,
      badge: 'React 19',
    },
    {
      id: 'synchronizer' as ActiveTab,
      label: t('synchronizer'),
      sub: 'Real-time State Ticker',
      icon: Activity,
      badge: '45ms',
    },
    {
      id: 'security_auth' as ActiveTab,
      label: t('securityAuth'),
      sub: 'Sessions & RBAC',
      icon: Shield,
      badge: 'RBAC',
    },
    {
      id: 'audit_log' as ActiveTab,
      label: t('auditLog'),
      sub: 'Hash-chained decisions',
      icon: ScrollText,
      badge: 'Audit',
    },
  ];

  return (
    // Widened from w-64: at 64 the badge and chevron squeezed every label into
    // an ellipsis ("Revenue Boardr…"), which defeats the point of a nav label.
    <aside className={`w-full md:w-72 flex flex-col justify-between p-3 shrink-0 font-mono border-r transition-all overflow-y-auto ${
      isHighContrast ? 'bg-black border-white text-white' : 'bg-zinc-950 border-zinc-800/80'
    }`}>
      <div className="space-y-1">
        <div className="px-3 py-2 text-[10px] uppercase text-zinc-500 font-bold tracking-wider">
          System Modules
        </div>

        {menuItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`w-full text-left p-2.5 rounded-xl transition-all flex items-center justify-between group cursor-pointer border ${
                isActive
                  ? isHighContrast
                    ? 'bg-white text-black border-2 border-white font-bold shadow-md'
                    : 'bg-zinc-900 border-emerald-500/40 text-emerald-400 shadow-md shadow-emerald-950/20'
                  : isHighContrast
                  ? 'bg-transparent border-transparent text-white hover:bg-zinc-900'
                  : 'bg-transparent border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60'
              }`}
            >
              <div className="flex items-center space-x-3 overflow-hidden">
                <div
                  className={`p-1.5 rounded-lg border ${
                    isActive
                      ? isHighContrast
                        ? 'bg-black border-black text-white'
                        : 'bg-emerald-950/80 border-emerald-500/40 text-emerald-400'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 group-hover:text-zinc-200'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                </div>
                <div className="truncate">
                  <div className="text-xs font-semibold leading-tight truncate">{item.label}</div>
                  <div className={`text-[10px] leading-tight truncate ${isHighContrast ? 'text-zinc-400' : 'text-zinc-500'}`}>
                    {item.sub}
                  </div>
                </div>
              </div>

              <div className="flex items-center space-x-1 shrink-0">
                <span
                  className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                    isActive
                      ? isHighContrast
                        ? 'bg-black text-yellow-400 border border-black font-extrabold'
                        : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      : 'bg-zinc-900 text-zinc-500 border border-zinc-800'
                  }`}
                >
                  {item.badge}
                </span>
                <ChevronRight
                  className={`w-3.5 h-3.5 transition-transform ${
                    isActive
                      ? isHighContrast
                        ? 'text-black translate-x-0.5'
                        : 'text-emerald-400 translate-x-0.5'
                      : 'text-zinc-600 group-hover:text-zinc-400'
                  }`}
                />
              </div>
            </button>
          );
        })}
      </div>

      {/* System Architecture Info Box */}
      <div className={`mt-4 p-3 rounded-xl border text-[11px] ${
        isHighContrast ? 'bg-black border-white text-white' : 'bg-zinc-900/80 border-zinc-800/80 text-zinc-400'
      }`}>
        <div className="flex items-center space-x-2 font-bold mb-1">
          <Layers className="w-3.5 h-3.5 text-emerald-400" />
          <span>V12 APEX ARCHITECTURE</span>
        </div>
        <p className={`text-[10px] leading-normal ${isHighContrast ? 'text-zinc-300' : 'text-zinc-500'}`}>
          GLM-5.2 + MoL (Mixture of LoRAs) substrate with Hermes zero-loss execution rules and 45ms replication cycle.
        </p>
      </div>
    </aside>
  );
};
