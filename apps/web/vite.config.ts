import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Aliased to the workspace packages' source. The app is the fastest way to find out that
// a schema change was wrong, so it should not be reading a stale build of one.
export default defineConfig({
  // Relative asset URLs, so one build works whether it is served from a domain root or
  // from a subpath like GitHub Pages' /<repo>/. The app is a single page with no router,
  // so there is nothing that needs to know its own base.
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@evocut/edl': fileURLToPath(new URL('../../packages/edl/src/index.ts', import.meta.url)),
      '@evocut/renderer': fileURLToPath(new URL('../../packages/renderer/src/index.ts', import.meta.url)),
      '@evocut/agent': fileURLToPath(new URL('../../packages/agent/src/index.ts', import.meta.url)),
      '@evocut/store': fileURLToPath(new URL('../../packages/store/src/index.ts', import.meta.url)),
    },
  },
  server: {
    // The coarse pass is a phone workflow; testing it means opening the dev server
    // from a phone on the same network.
    host: true,
  },
});
