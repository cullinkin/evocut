import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

// Vitest inherits the app's aliases, so a unit test imports `@evocut/edl` the same way the
// app does. The include list is narrowed because the default pattern would also sweep up
// `e2e/*.spec.mjs`, which are Playwright scripts that drive a real browser and exit the
// process themselves — they are run by `npm run e2e`, not by this.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['test/**/*.test.ts'],
    },
  }),
);
