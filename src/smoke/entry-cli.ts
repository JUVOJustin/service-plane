import { runSmoke } from './smoke.js';

// CLI shape of the smoke: Deno, Bun, and Node all run the same esbuild bundle of this file.
// Failure is a rejected promise — every runtime exits non-zero on an unhandled rejection.
const passed = await runSmoke();
console.log(`smoke ok: ${passed.join(', ')}`);
