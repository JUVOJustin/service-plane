import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// The real test suite, executed inside actual workerd isolates via vitest-pool-workers — the
// deployment runtime, not a Node simulation of it. `nodejs_compat` serves the vitest runner
// machinery only; the library itself stays web-standard, which the Deno/Bun smoke keeps proving.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-07-01',
        compatibilityFlags: ['nodejs_compat'],
      },
      // One isolate for the whole suite: the tests share no mutable module state across files
      // beyond what each constructs itself, and per-file isolates multiply startup cost.
      singleWorker: true,
    }),
  ],
  test: {
    exclude: [
      '**/node_modules/**',
      // Reads package.json through node:fs — meaningless inside an isolate.
      'src/package-metadata.test.ts',
    ],
    include: ['src/**/*.test.ts'],
  },
});
