/**
 * Runs a generated component inside an isolated iframe.
 *
 * WHY THIS EXISTS
 * ---------------
 * Executing model-generated code is the REPL's entire purpose, but doing it in
 * the application's own document means that code runs with the app's
 * privileges: same-origin fetch, storage, and the parent DOM. The iframe is
 * loaded with `sandbox="allow-scripts"` and deliberately WITHOUT
 * `allow-same-origin`, which puts it on an opaque origin — it cannot read the
 * parent DOM, cookies, or storage even though it is served from our host. Its
 * own CSP (set by the `/repl-sandbox` route) adds `connect-src 'none'`, so it
 * has no network egress either.
 *
 * Net effect: the worst a hostile artifact can do is draw the wrong pixels.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { collectAppCss } from '../lib/compileArtifact';

interface Props {
  /** Already-transpiled source declaring `__ApexArtifact`. */
  code: string | null;
  propsData: unknown;
  onError?: (message: string, phase: string) => void;
}

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 2000;
/** If the sandbox never reports back, say so rather than spinning forever. */
const RENDER_TIMEOUT_MS = 8000;

export const SandboxedArtifact: React.FC<Props> = ({ code, propsData, onError }) => {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const nonceRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [height, setHeight] = useState(MIN_HEIGHT);
  const [status, setStatus] = useState<'booting' | 'rendering' | 'rendered' | 'error'>('booting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const send = useCallback(() => {
    const frame = frameRef.current;
    if (!frame?.contentWindow || !readyRef.current || !code) return;

    nonceRef.current += 1;
    setStatus('rendering');
    setErrorMessage(null);

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setStatus('error');
      setErrorMessage('The sandbox did not respond. It may have been blocked by the browser.');
    }, RENDER_TIMEOUT_MS);

    frame.contentWindow.postMessage(
      { type: 'apex:render', nonce: nonceRef.current, code, props: propsData, css: collectAppCss() },
      // The sandbox has an opaque origin, so a specific target origin is not
      // expressible here. Confidentiality is not the concern in this direction:
      // we are sending code we just produced to a frame we created.
      '*',
    );
  }, [code, propsData]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Authenticate by frame identity, not origin: a sandboxed document's
      // origin serialises to "null", so an origin check would be meaningless.
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;

      const data = event.data;
      if (!data || typeof data !== 'object') return;

      switch (data.type) {
        case 'apex:ready':
          readyRef.current = true;
          send();
          break;

        case 'apex:rendered':
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          setStatus('rendered');
          break;

        case 'apex:height':
          if (typeof data.height === 'number') {
            setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, data.height + 8)));
          }
          break;

        case 'apex:error': {
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          const message = String(data.message ?? 'Unknown sandbox error');
          setStatus('error');
          setErrorMessage(message);
          onError?.(message, String(data.phase ?? 'unknown'));
          break;
        }
      }
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [send, onError]);

  useEffect(() => {
    if (readyRef.current) send();
  }, [send]);

  return (
    <div className="space-y-2">
      <div className="relative rounded-lg overflow-hidden bg-zinc-950/60 border border-zinc-800/70">
        {status !== 'rendered' && status !== 'error' && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-zinc-400 font-mono bg-zinc-950/80 z-10">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" aria-hidden="true" />
            <span>{status === 'booting' ? 'Starting sandbox…' : 'Rendering artifact…'}</span>
          </div>
        )}

        <iframe
          ref={frameRef}
          src="/repl-sandbox"
          title="Generated component preview (sandboxed)"
          // No allow-same-origin: this is what forces the opaque origin.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="w-full block border-0 bg-transparent"
          style={{ height }}
        />
      </div>

      {status === 'error' && errorMessage && (
        <div
          role="alert"
          className="p-3 rounded-lg bg-red-950/70 border border-red-600/60 text-red-100 font-mono text-xs"
        >
          <pre className="whitespace-pre-wrap break-words leading-relaxed">{errorMessage}</pre>
        </div>
      )}

      <p className="text-[10px] text-zinc-500 font-sans flex items-start gap-1.5">
        <ShieldCheck className="w-3 h-3 mt-0.5 shrink-0 text-emerald-500" aria-hidden="true" />
        <span>
          Isolated frame — opaque origin, no access to the page, your session, storage, or the network.
        </span>
      </p>
    </div>
  );
};
