/**
 * Serves the REPL sandbox document.
 *
 * The route sets its OWN Content-Security-Policy, deliberately different from
 * the app's: `default-src 'none'` with `connect-src 'none'` means generated
 * code has no network egress at all. Combined with the `sandbox="allow-scripts"`
 * attribute the parent applies (note: no `allow-same-origin`), the document
 * runs on an opaque origin with no access to cookies, storage, or the parent
 * DOM.
 *
 * The runtime bundle is inlined rather than linked because an opaque-origin
 * document cannot resolve `'self'` in its own CSP, so a `<script src>` would
 * need a wildcard to load — which would defeat the point.
 */

import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';

const SANDBOX_CSP = [
  "default-src 'none'",
  // The runtime is inlined; artifacts are instantiated with `new Function`.
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  // No network egress. A generated component cannot exfiltrate anything,
  // because there is nothing here to take and nowhere to send it.
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

let cachedRuntime: string | null = null;
let cachedAt = 0;

const RUNTIME_PATHS = [
  path.join(process.cwd(), 'dist', 'client', 'repl-sandbox.js'),
  path.join(process.cwd(), 'public', 'repl-sandbox.js'),
];

function loadRuntime(isProd: boolean): string {
  // In development the bundle is rebuilt by `npm run dev`'s pre-step; re-read
  // it periodically so edits show up without restarting the server.
  const ttl = isProd ? Infinity : 2000;
  if (cachedRuntime && Date.now() - cachedAt < ttl) return cachedRuntime;

  for (const candidate of RUNTIME_PATHS) {
    if (fs.existsSync(candidate)) {
      cachedRuntime = fs.readFileSync(candidate, 'utf8');
      cachedAt = Date.now();
      return cachedRuntime;
    }
  }

  throw new Error(
    'REPL sandbox runtime not built. Run `npm run build:sandbox` (or `npm run build`).',
  );
}

export function serveSandbox(isProd: boolean) {
  return (_req: Request, res: Response) => {
    let runtime: string;
    try {
      runtime = loadRuntime(isProd);
    } catch (err) {
      res.status(503).type('text/plain').send(err instanceof Error ? err.message : 'Runtime unavailable');
      return;
    }

    res.setHeader('Content-Security-Policy', SANDBOX_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', isProd ? 'public, max-age=300' : 'no-store');
    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>Artifact sandbox</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; color: #e4e4e7;
    font-family: ui-sans-serif, system-ui, sans-serif; overflow: hidden; }
  #artifact-root { display: block; }
  .apex-sandbox-error { padding: 12px; border-radius: 10px; border: 1px solid #b91c1c;
    background: #450a0a; color: #fecaca; font: 12px/1.6 ui-monospace, monospace; }
</style>
</head>
<body>
<div id="artifact-root"></div>
<script>${runtime}</script>
</body>
</html>`);
  };
}
