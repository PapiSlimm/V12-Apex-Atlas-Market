/**
 * REPL sandbox runtime.
 *
 * This bundle runs INSIDE the sandboxed iframe, not in the app. It is built
 * separately (`npm run build:sandbox`) and inlined into the `/repl-sandbox`
 * document by the server.
 *
 * The iframe is loaded with `sandbox="allow-scripts"` and deliberately WITHOUT
 * `allow-same-origin`, so this document runs on an opaque origin: no access to
 * the parent's DOM, no cookies, no localStorage, no IndexedDB, no same-origin
 * fetch. Its own CSP additionally sets `connect-src 'none'`, so generated code
 * cannot phone home either. What it can do is render pixels and tell the parent
 * how tall it is.
 *
 * The parent transpiles JSX before sending it here — Babel stays in the app
 * bundle rather than being shipped twice.
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';

type RenderMessage = {
  type: 'apex:render';
  nonce: number;
  code: string;
  props: unknown;
  css?: string;
};

const container = document.getElementById('artifact-root')!;
let root: Root | null = null;
let styleEl: HTMLStyleElement | null = null;

function post(message: Record<string, unknown>) {
  // Our origin is opaque, so we cannot target a specific origin here. The
  // parent authenticates replies by comparing event.source against this
  // iframe's contentWindow, which is not spoofable.
  window.parent.postMessage(message, '*');
}

function reportHeight() {
  const height = Math.max(
    container.scrollHeight,
    container.getBoundingClientRect().height,
    document.body.scrollHeight,
  );
  post({ type: 'apex:height', height: Math.ceil(height) });
}

/** Contains render-time throws so a bad artifact shows an error, not a blank frame. */
class Boundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    post({ type: 'apex:error', phase: 'render', message: error.message });
  }

  render() {
    if (this.state.error) {
      return React.createElement(
        'div',
        { className: 'apex-sandbox-error' },
        `Component threw while rendering: ${this.state.error.message}`,
      );
    }
    return this.props.children;
  }
}

function applyCss(css: string | undefined) {
  if (!css) return;
  if (!styleEl) {
    styleEl = document.createElement('style');
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = css;
}

function render(message: RenderMessage) {
  try {
    applyCss(message.css);

    // `code` arrives already transpiled to React.createElement calls.
    const factory = new Function('React', `"use strict";\n${message.code}\nreturn __ApexArtifact;`);
    const Component = factory(React);

    if (typeof Component !== 'function') {
      throw new Error('Compiled artifact is not a function component.');
    }

    if (!root) root = createRoot(container);
    root.render(
      React.createElement(Boundary, null, React.createElement(Component, { data: message.props })),
    );

    post({ type: 'apex:rendered', nonce: message.nonce });
    // Two frames: one for React to commit, one for layout/fonts to settle.
    requestAnimationFrame(() => requestAnimationFrame(reportHeight));
  } catch (err) {
    post({
      type: 'apex:error',
      phase: 'instantiate',
      nonce: message.nonce,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'apex:render') render(data as RenderMessage);
});

// Keep the parent's frame height honest as content reflows.
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(reportHeight).observe(container);
}

post({ type: 'apex:ready' });
