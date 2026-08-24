import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {readFileSync} from 'fs';

// Stamped into the client at build time. The snapshot export previously carried
// a hardcoded version string that had drifted from package.json by a minor
// release, which makes an exported audit artefact impossible to correlate with
// the build that produced it.
const {version} = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));

export default defineConfig(() => {
  return {
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
    plugins: [react(), tailwindcss()],
    build: {
      // Client assets get their own directory. Previously both the client
      // bundle and the compiled server (plus its sourcemap) landed in `dist/`,
      // which `express.static` then served — publishing the backend source to
      // anyone who requested /server.cjs.map.
      outDir: 'dist/client',
      emptyOutDir: true,
      sourcemap: false,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks: { d3: ['d3'] },
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
