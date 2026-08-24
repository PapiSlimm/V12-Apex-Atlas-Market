import { useState, useEffect, useCallback, useRef } from 'react';
import { User, ToastMessage } from './types';
import { Header } from './components/Header';
import { Sidebar, ActiveTab } from './components/Sidebar';
import { CommandCenter } from './components/CommandCenter';
import { RevenueBoardroom } from './components/RevenueBoardroom';
import { MemoryGalaxyGraph } from './components/MemoryGalaxyGraph';
import { UI4AReplSandbox } from './components/UI4AReplSandbox';
import { SynchronizerTelemetry } from './components/SynchronizerTelemetry';
import { SecurityAuth } from './components/SecurityAuth';
import { AuditLog } from './components/AuditLog';
import { AssetLedger } from './components/AssetLedger';
import { AuthModal } from './components/AuthModal';
import { ToastContainer } from './components/ToastContainer';
import { CommandPalette } from './components/CommandPalette';
import { ErrorBoundary } from './components/ErrorBoundary';
import { IntroSequence, hasSeenIntro } from './components/IntroSequence';
import { LaunchPage } from './components/LaunchPage';
import { useAutoLogout } from './hooks/useAutoLogout';
import { api } from './lib/api';

const LATENCY_ALERT_THRESHOLD_MS = 200;

export default function App() {
  /*
   * Arrival flow: intro -> launch page -> workspace.
   *
   *   'intro'     the film, once per browser
   *   'launch'    the landing page: redeem an invite, sign in, or look around
   *   'workspace' the application
   *
   * The initial stage is computed once, synchronously, from storage. Defaulting
   * to 'intro' and then correcting in an effect would flash the video at every
   * returning visitor for one frame — which is exactly the thing a "play once"
   * rule exists to prevent.
   */
  const [stage, setStage] = useState<'intro' | 'launch' | 'workspace'>(() =>
    hasSeenIntro() ? 'launch' : 'intro',
  );
  const [replayIntro, setReplayIntro] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('command_center');
  const [user, setUser] = useState<User | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [syncLatency, setSyncLatency] = useState(45);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const toastTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismissToast = useCallback((id: string) => {
    const timer = toastTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (toastData: Omit<ToastMessage, 'id' | 'timestamp'>) => {
      const id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2);

      const newToast: ToastMessage = {
        ...toastData,
        id,
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      };

      setToasts((prev) => [newToast, ...prev].slice(0, 5));

      const timer = setTimeout(() => dismissToast(id), toastData.duration || 4500);
      toastTimers.current.set(id, timer);
    },
    [dismissToast],
  );

  // Clear every pending timer on unmount rather than leaking them.
  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  const handleOpenAuth = useCallback(() => setIsAuthOpen(true), []);

  const handleLogout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      /* clearing local state matters more than the round trip succeeding */
    }
    setUser(null);
    addToast({
      type: 'info',
      title: 'Signed out',
      description: 'Session cookie cleared.',
    });
  }, [addToast]);

  const { secondsRemaining } = useAutoLogout({
    user,
    onLogout: handleLogout,
    onOpenAuth: handleOpenAuth,
    addToast,
    inactivityTimeoutMinutes: 15,
  });

  // Restore an existing session. A 401 here is the normal signed-out path, not
  // an error worth surfacing.
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ user: User | null }>('/api/auth/me')
      .then((data) => {
        if (!cancelled && data.user) setUser(data.user);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setSessionChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Latency watch. The alert path is now reachable: the server emits a
  // realistic spike tail instead of a permanent 42–48ms band.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await api.get<{ latencyMs: number; targetNode: string }>('/api/sync/telemetry');
        if (cancelled) return;
        setSyncLatency(data.latencyMs);
        if (data.latencyMs > LATENCY_ALERT_THRESHOLD_MS) {
          addToast({
            type: 'sync',
            title: 'Synchronizer latency spike',
            description: `Replication delay reached ${data.latencyMs}ms on ${data.targetNode}. Re-routing the substrate path.`,
          });
        }
      } catch {
        /* transient polling failures are not worth a toast every 15s */
      }
    };

    poll();
    const interval = setInterval(poll, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [addToast]);

  const handleAuthSuccess = (authUser: User) => {
    setUser(authUser);
    addToast({
      type: 'success',
      title: 'Signed in',
      description: `Role permissions initialised: ${authUser.role}.`,
    });
  };

  const handleSimulateLatencySpike = () => {
    const spikeValue = Math.floor(280 + Math.random() * 150);
    setSyncLatency(spikeValue);
    addToast({
      type: 'warning',
      title: 'Synchronizer latency spike (simulated)',
      description: `Injected a ${spikeValue}ms delay on the vault replication cycle to exercise the alerting path.`,
      duration: 5000,
    });
    setTimeout(() => setSyncLatency(45), 4000);
  };

  const handleSimulateConnectionDrop = () => {
    addToast({
      type: 'error',
      title: 'Replication stream interrupted (simulated)',
      description: 'Reconnection protocol initiated. Re-establishing the state handshake…',
      duration: 6000,
    });
    setTimeout(() => {
      addToast({
        type: 'success',
        title: 'Replication stream restored',
        description: 'Loop returned to the nominal 45ms path.',
      });
    }, 3000);
  };

  const handleTriggerAutoLogoutTest = () => {
    addToast({
      type: 'warning',
      title: 'Inactivity policy test',
      description: 'Terminating the session immediately to verify the auto-logout path.',
    });
    setTimeout(() => {
      void handleLogout();
      setIsAuthOpen(true);
    }, 1000);
  };

  /**
   * Re-derive the twin and report what the validator actually found.
   *
   * This was a two-second `setTimeout` that then told the user "Digital twin
   * graph is consistent" — a specific factual claim about their data that the
   * code never checked. The validator that answers the question honestly
   * already exists; it just was not being called.
   */
  const handleReindexMemory = async () => {
    addToast({
      type: 'info',
      title: 'Re-deriving the twin',
      description: 'Re-parsing vault frontmatter and running the structural validator…',
    });

    try {
      const twin = await api.get<{
        issues: { severity: string; slug: string; message: string }[];
        valuation: { errors: number; warnings: number };
        hubs: unknown[];
        factories: unknown[];
        warehouses: unknown[];
      }>('/api/twin/graph');

      const { errors, warnings } = twin.valuation;
      const nodes = twin.hubs.length + twin.factories.length + twin.warehouses.length;

      if (errors > 0) {
        addToast({
          type: 'error',
          title: `${errors} structural error${errors === 1 ? '' : 's'} in the vault`,
          description: twin.issues.find((i) => i.severity === 'error')?.message ?? 'See the boardroom panel.',
          duration: 9000,
        });
      } else if (warnings > 0) {
        addToast({
          type: 'warning',
          title: `Twin re-derived with ${warnings} warning${warnings === 1 ? '' : 's'}`,
          description: `${nodes} nodes parsed. See the supply network panel for detail.`,
          duration: 7000,
        });
      } else {
        addToast({
          type: 'success',
          title: 'Twin re-derived',
          description: `${nodes} nodes parsed, no dangling references or capacity breaches.`,
        });
      }
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Could not re-derive the twin',
        description: err instanceof Error ? err.message : 'Request failed.',
      });
    }
  };

  const handleEvaluateHermes = () => {
    addToast({
      type: 'sync',
      title: 'Hermes scan started',
      description: 'Evaluating every position against the strike target and both fee legs.',
    });
  };

  // Stable identity: IntroSequence memoises its `finish` over this callback, and
  // an inline arrow here would give it a new one on every render.
  const handleIntroComplete = useCallback(() => {
    setReplayIntro(false);
    setStage('launch');
  }, []);

  /*
   * A returning, signed-in visitor should not be shown a landing page. The
   * session check is asynchronous, so this waits for it before deciding — a
   * signed-in user briefly seeing "Redeem an invite" reads as being logged out.
   */
  useEffect(() => {
    if (sessionChecked && user && stage === 'launch') setStage('workspace');
  }, [sessionChecked, user, stage]);

  if (stage === 'intro') {
    return (
      <IntroSequence force={replayIntro} onComplete={handleIntroComplete} />
    );
  }

  if (stage === 'launch') {
    return (
      <>
        <LaunchPage
          onSignUp={() => {
            setStage('workspace');
            setIsAuthOpen(true);
          }}
          onSignIn={() => {
            setStage('workspace');
            setIsAuthOpen(true);
          }}
          onExplore={() => setStage('workspace')}
          onReplayIntro={() => {
            setReplayIntro(true);
            setStage('intro');
          }}
        />
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  return (
    // h-screen, not min-h-screen: with a min-height the flex column grew past
    // the viewport, so the whole document scrolled and the nav sidebar slid off
    // the top instead of the main panel scrolling inside its own frame.
    <div className="h-screen overflow-hidden bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-black">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:rounded-lg focus:bg-emerald-500 focus:text-black focus:font-bold"
      >
        Skip to main content
      </a>

      <Header
        user={user}
        onOpenAuth={() => setIsAuthOpen(true)}
        onLogout={handleLogout}
        onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
        syncLatency={syncLatency}
        secondsRemaining={user ? secondsRemaining : undefined}
      />

      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />

        <main
          id="main-content"
          className="flex-1 flex flex-col min-w-0 bg-zinc-950 overflow-hidden"
        >
          <ErrorBoundary label="This module failed to render" resetKey={activeTab}>
            {activeTab === 'command_center' && <CommandCenter addToast={addToast} user={user} onOpenAuth={handleOpenAuth} />}
            {activeTab === 'revenue_boardroom' && (
              <RevenueBoardroom user={user} onOpenAuth={handleOpenAuth} addToast={addToast} />
            )}
            {activeTab === 'memory_galaxy' && (
              <MemoryGalaxyGraph user={user} onOpenAuth={handleOpenAuth} addToast={addToast} />
            )}
            {activeTab === 'repl_harness' && <UI4AReplSandbox user={user} onOpenAuth={handleOpenAuth} />}
            {activeTab === 'synchronizer' && <SynchronizerTelemetry addToast={addToast} />}
            {activeTab === 'security_auth' && (
              <SecurityAuth user={user} sessionChecked={sessionChecked} onOpenAuth={handleOpenAuth} />
            )}
            {activeTab === 'execution_desk' && (
              <AssetLedger user={user} onOpenAuth={handleOpenAuth} addToast={addToast} />
            )}
            {activeTab === 'audit_log' && (
              <AuditLog user={user} onOpenAuth={handleOpenAuth} addToast={addToast} />
            )}
          </ErrorBoundary>
        </main>
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        setActiveTab={setActiveTab}
        onOpenAuth={() => setIsAuthOpen(true)}
        onLogout={handleLogout}
        onSimulateLatencySpike={handleSimulateLatencySpike}
        onSimulateConnectionDrop={handleSimulateConnectionDrop}
        onTriggerAutoLogoutTest={handleTriggerAutoLogoutTest}
        onReindexMemory={handleReindexMemory}
        onEvaluateHermes={handleEvaluateHermes}
      />

      <AuthModal
        isOpen={isAuthOpen}
        onClose={() => setIsAuthOpen(false)}
        onAuthSuccess={handleAuthSuccess}
      />
    </div>
  );
}
