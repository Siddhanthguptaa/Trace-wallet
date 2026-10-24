import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  // The frontend's schemas (web/src/api/schemas.ts) import 'zod' and the web app has no node_modules here:
  // resolve it to this package's zod so the test can parse our output with the frontend's own schemas.
  resolve: { alias: { zod: resolve(here, 'node_modules/zod') } },
  test: { testTimeout: 180_000, hookTimeout: 180_000 },
});
