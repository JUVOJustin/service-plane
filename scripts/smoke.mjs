// Builds the runtime-portability smoke bundle: one esbuild pass over src/smoke, executed
// unchanged by Deno, Bun, and the Node CI job.
//
//   node scripts/smoke.mjs
//
// Bundling keeps every runtime on identical bytes, and `platform: 'neutral'` makes the build
// itself the first assertion: a Node-only dependency reaching the library fails here rather than
// at runtime on someone's Worker. esbuild resolves this repo's `./x.js` specifiers to `./x.ts`,
// so the bundle builds straight from source without a prior `npm run build`.
//
// workerd is not a smoke target — it runs the real vitest suite inside actual isolates via
// `npm run test:workerd` (vitest.workerd.config.ts), which strictly covers more.
import { build } from 'esbuild';

await build({
  bundle: true,
  entryPoints: ['src/smoke/entry-cli.ts'],
  format: 'esm',
  logLevel: 'silent',
  outfile: 'smoke-dist/cli.mjs',
  platform: 'neutral',
  // hono publishes worker/browser/import conditions; prefer the portable ESM entrypoints.
  conditions: ['worker', 'import'],
  target: 'es2022',
});
console.log('smoke bundle built: smoke-dist/cli.mjs');
