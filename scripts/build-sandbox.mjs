/**
 * Builds the REPL sandbox runtime.
 *
 * Kept as a script rather than an inline npm command because the
 * `process.env.NODE_ENV` define needs embedded double quotes, and quoting that
 * correctly across POSIX shells and cmd.exe from inside package.json is not
 * worth the trouble. Getting it wrong silently ships development React —
 * three times the bytes and much slower.
 */
import { build } from 'esbuild';

const dev = process.argv.includes('--dev');

const result = await build({
  entryPoints: ['src/repl-sandbox/runtime.tsx'],
  outfile: 'dist/client/repl-sandbox.js',
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: !dev,
  sourcemap: false,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
  logLevel: 'warning',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`[sandbox] built dist/client/repl-sandbox.js (${(bytes / 1024).toFixed(1)} kB)`);
