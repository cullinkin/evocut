import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Point at the EDL package's source rather than its build output, so a change to the
// schema is reflected in these tests without a build step in between.
export default defineConfig({
  resolve: {
    alias: {
      '@evocut/edl': fileURLToPath(new URL('../edl/src/index.ts', import.meta.url)),
    },
  },
});
