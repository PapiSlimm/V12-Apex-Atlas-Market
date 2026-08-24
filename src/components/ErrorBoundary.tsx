import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** Changing this value resets the boundary — used to retry after a recompile. */
  resetKey?: unknown;
  label?: string;
  compact?: boolean;
}

interface State {
  error: Error | null;
}

/**
 * Without this, a single throwing artifact from the REPL unmounted the entire
 * React tree and left the operator staring at a blank page with no way back.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label || 'ErrorBoundary'}]`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        className={`rounded-xl border border-red-500/50 bg-red-950/50 text-red-200 font-mono ${
          this.props.compact ? 'p-3 text-xs' : 'p-6 text-sm'
        }`}
      >
        <div className="flex items-center space-x-2 mb-2 font-bold">
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{this.props.label || 'Something went wrong'}</span>
        </div>
        <p className="font-sans text-red-100/90 break-words mb-3">{error.message}</p>
        <button
          type="button"
          onClick={this.reset}
          className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-red-900/70 hover:bg-red-900 border border-red-500/50 text-red-100 text-xs font-bold transition-colors cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Try again</span>
        </button>
      </div>
    );
  }
}
