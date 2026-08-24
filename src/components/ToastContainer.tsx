import React from 'react';
import { ToastMessage } from '../types';
import {
  Zap,
  AlertTriangle,
  AlertOctagon,
  CheckCircle2,
  Info,
  X,
  Clock,
} from 'lucide-react';

interface ToastContainerProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col space-y-2.5 max-w-sm w-full px-4 sm:px-0 pointer-events-none font-mono">
      {toasts.map((toast) => {
        const getIcon = () => {
          switch (toast.type) {
            case 'sync':
              return <Zap className="w-4 h-4 text-cyan-400 animate-pulse shrink-0" />;
            case 'warning':
              return <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />;
            case 'error':
              return <AlertOctagon className="w-4 h-4 text-red-400 shrink-0" />;
            case 'success':
              return <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />;
            case 'info':
            default:
              return <Info className="w-4 h-4 text-indigo-400 shrink-0" />;
          }
        };

        const getBorderColor = () => {
          switch (toast.type) {
            case 'sync':
              return 'border-cyan-500/50 bg-cyan-950/90 text-cyan-100 shadow-cyan-950/50';
            case 'warning':
              return 'border-amber-500/50 bg-amber-950/90 text-amber-100 shadow-amber-950/50';
            case 'error':
              return 'border-red-500/50 bg-red-950/90 text-red-100 shadow-red-950/50';
            case 'success':
              return 'border-emerald-500/50 bg-emerald-950/90 text-emerald-100 shadow-emerald-950/50';
            case 'info':
            default:
              return 'border-indigo-500/50 bg-indigo-950/90 text-indigo-100 shadow-indigo-950/50';
          }
        };

        return (
          <div
            key={toast.id}
            className={`pointer-events-auto p-3.5 rounded-xl border backdrop-blur-md shadow-xl transition-all duration-300 transform translate-y-0 flex items-start space-x-3 ${getBorderColor()}`}
          >
            <div className="mt-0.5">{getIcon()}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between space-x-2">
                <span className="text-xs font-bold truncate leading-tight">{toast.title}</span>
                <span className="text-[10px] text-zinc-400 shrink-0 flex items-center space-x-1">
                  <Clock className="w-2.5 h-2.5" />
                  <span>{toast.timestamp}</span>
                </span>
              </div>
              {toast.description && (
                <p className="text-[11px] text-zinc-300 font-sans mt-1 leading-snug break-words">
                  {toast.description}
                </p>
              )}
            </div>
            <button
              onClick={() => onDismiss(toast.id)}
              className="text-zinc-400 hover:text-zinc-100 p-0.5 rounded transition-colors cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
