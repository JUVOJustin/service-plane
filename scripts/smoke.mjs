// Builds the runtime-portability smoke bundles and, on request, runs the workerd leg.
//
//   node scripts/smoke.mjs build     bundle src/smoke entries to smoke-dist/{cli,worker}.mjs
//   node scripts/smoke.mjs workerd   build, then execute the worker bundle in workerd via miniflare
//
// One esbuild bundle per shape keeps every runtime on identical bytes: Deno and Bun execute
// cli.mjs directly, and CI's Node job runs it too so a bundling-only regression cannot pass as
// "covered" by the vitest suite. esbuild resolves this repo's `./x.js` specifiers to `./x.ts`,
// so the bundles build straight from source without a prior `npm run build`.
import { build } from 'esbuild';

const mode = process.argv[2] ?? 'build';

const bundle = (entry, outfile) =>
  build({
    bundle: true,
    entryPoints: [entry],
    format: 'esm',
    logLevel: 'silent',
    outfile,
    // Neutral keeps Node-only shims out of the bundle; the library is web-standard by design and
    // the smoke exists to prove it, so a platform-specific dependency should fail the build here.
    platform: 'neutral',
    // hono publishes worker/browser/import conditions; prefer the portable ESM entrypoints.
    conditions: ['worker', 'import'],
    target: 'es2022',
  });

await bundle('src/smoke/entry-cli.ts', 'smoke-dist/cli.mjs');
await bundle('src/smoke/entry-worker.ts', 'smoke-dist/worker.mjs');
console.log('smoke bundles built: smoke-dist/cli.mjs, smoke-dist/worker.mjs');

if (mode === 'workerd') {
  const { Miniflare } = await import('miniflare');
  const miniflare = new Miniflare({
    compatibilityDate: '2026-07-01',
    modules: true,
    scriptPath: 'smoke-dist/worker.mjs',
  });
  try {
    const response = await miniflare.dispatchFetch('https://smoke.internal/');
    const body = await response.text();
    if (!response.ok) throw new Error(`workerd smoke failed (${response.status}): ${body}`);
    console.log(`workerd ${body}`);
  } finally {
    await miniflare.dispose();
  }
}
