import { runSmoke } from './smoke.js';

// Worker shape of the smoke: miniflare loads this bundle into a real workerd isolate and the
// driver dispatches one fetch. 200 carries the passed steps; failures surface as a 500 body.
export default {
  async fetch(): Promise<Response> {
    try {
      const passed = await runSmoke();
      return new Response(`smoke ok: ${passed.join(', ')}`);
    } catch (error) {
      return new Response(error instanceof Error ? (error.stack ?? error.message) : String(error), { status: 500 });
    }
  },
};
