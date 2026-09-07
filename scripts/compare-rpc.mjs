/**
 * Compares protocol overhead using real TCP loopback and identical input/output validation.
 * Usage: node scripts/compare-rpc.mjs <unpacked-capnweb-package-directory> [service-plane-directory]
 * Downloads nothing and adds no project dependency. Results exclude Service Plane authorization,
 * Hono, TLS, Cloudflare native RPC, cross-host latency, pipelining, and stream throughput.
 */
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [capnPackage, project = process.cwd()] = process.argv.slice(2);
if (!capnPackage) throw new Error('Expected the directory of an externally unpacked capnweb package');
const require = createRequire(resolve(project, 'package.json'));
const importDependency = (name) => import(pathToFileURL(require.resolve(name)).href);
const [{ os }, { RPCHandler }, { createORPCClient }, { RPCLink }, { BatchHandlerPlugin }, { BatchLinkPlugin }, capn] = await Promise.all([
  importDependency('@orpc/server'),
  importDependency('@orpc/server/fetch'),
  importDependency('@orpc/client'),
  importDependency('@orpc/client/fetch'),
  importDependency('@orpc/server/plugins'),
  importDependency('@orpc/client/plugins'),
  import(pathToFileURL(resolve(capnPackage, 'dist/index.js')).href),
]);

// Both engines invoke this exact function, including the same two validation calls.
function echo(input) {
  validate(input);
  const output = { value: input.value };
  validate(output);
  return output;
}

// A shared validator avoids comparing one engine's schema library against another's.
function validate(value) {
  if (value === null || typeof value !== 'object' || typeof value.value !== 'string') {
    throw new Error('Expected { value: string }');
  }
}

// Cap'n Web's object-capability boundary delegates to the same application function as oRPC.
class EchoTarget extends capn.RpcTarget {
  echo(input) {
    return echo(input);
  }
}

const handler = new RPCHandler({ echo: os.handler(({ input }) => echo(input)) }, { plugins: [new BatchHandlerPlugin()] });
const metrics = { requests: 0, requestBytes: 0, responseBytes: 0 };

// Both Fetch handlers share this bridge so neither benefits from a specialized Node adapter.
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    metrics.requests += 1;
    metrics.requestBytes += body.length;
    const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers,
      ...(body.length > 0 ? { body } : {}),
    });
    const response = incoming.url.startsWith('/capn')
      ? await capn.newHttpBatchRpcResponse(request, new EchoTarget())
      : (await handler.handle(request, { prefix: '/orpc' })).response;
    if (!response) throw new Error('No matching benchmark endpoint');
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      for await (const chunk of response.body) {
        metrics.responseBytes += chunk.byteLength;
        if (!outgoing.write(chunk)) await once(outgoing, 'drain');
      }
    }
    outgoing.end();
  } catch (error) {
    outgoing.destroy(error);
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const orpc = createORPCClient(new RPCLink({ origin, url: '/orpc' }));
const orpcBatch = createORPCClient(
  new RPCLink({
    origin,
    url: '/orpc',
    plugins: [new BatchLinkPlugin({ groups: [{ condition: true, context: {} }] })],
  }),
);
const orpcBufferedBatch = createORPCClient(
  new RPCLink({
    origin,
    url: '/orpc',
    plugins: [new BatchLinkPlugin({ mode: 'buffered', groups: [{ condition: true, context: {} }] })],
  }),
);

// HTTP sessions represent one request batch and are disposed after its results settle.
async function callCapn(input, count) {
  const session = capn.newHttpBatchRpcSession(`${origin}/capn`);
  try {
    return await Promise.all(Array.from({ length: count }, () => session.echo(input)));
  } finally {
    session[Symbol.dispose]();
  }
}

// The default streaming batch mode settles each logical call as its response arrives.
async function callOrpc(input, count) {
  const client = count === 1 ? orpc : orpcBatch;
  return Promise.all(Array.from({ length: count }, () => client.echo(input)));
}

// Buffered mode separates framing overhead from the shared batch scheduler's cost.
async function callOrpcBuffered(input, count) {
  const client = count === 1 ? orpc : orpcBufferedBatch;
  return Promise.all(Array.from({ length: count }, () => client.echo(input)));
}

const samplesPerRound = 200;
const rounds = 5;
const warmup = 100;
const scenarios = [
  { name: 'one call, 16-byte value', bytes: 16, count: 1 },
  { name: 'one call, 8 KiB value', bytes: 8192, count: 1 },
  { name: 'ten concurrent calls, 16-byte values', bytes: 16, count: 10 },
  { name: 'ten concurrent calls, 8 KiB values', bytes: 8192, count: 10 },
];
const results = [];
try {
  for (const scenario of scenarios) {
    const input = { value: 'x'.repeat(scenario.bytes) };
    const engines = [
      { name: 'oRPC', invoke: callOrpc },
      ...(scenario.count > 1 ? [{ name: 'oRPC buffered batch', invoke: callOrpcBuffered }] : []),
      { name: "Cap'n Web", invoke: callCapn },
    ];
    const totals = new Map(
      engines.map(({ name }) => [name, { elapsedMs: 0, latencies: [], requests: 0, requestBytes: 0, responseBytes: 0 }]),
    );
    for (const { invoke } of engines) {
      for (let i = 0; i < warmup; i += 1) await invoke(input, scenario.count);
    }
    // Reverse order on alternating rounds to reduce persistent order/thermal bias.
    for (let round = 0; round < rounds; round += 1) {
      for (const { name, invoke } of round % 2 === 0 ? engines : [...engines].reverse()) {
        Object.assign(metrics, { requests: 0, requestBytes: 0, responseBytes: 0 });
        const total = totals.get(name);
        const started = performance.now();
        for (let sample = 0; sample < samplesPerRound; sample += 1) {
          const callStarted = performance.now();
          const values = await invoke(input, scenario.count);
          total.latencies.push(performance.now() - callStarted);
          if (values.length !== scenario.count || values.some((v) => v.value !== input.value)) throw new Error('Invalid benchmark result');
        }
        total.elapsedMs += performance.now() - started;
        for (const field of ['requests', 'requestBytes', 'responseBytes']) total[field] += metrics[field];
      }
    }
    for (const { name } of engines) {
      const total = totals.get(name);
      const samples = rounds * samplesPerRound;
      total.latencies.sort((a, b) => a - b);
      results.push({
        scenario: scenario.name,
        engine: name,
        logicalCallsPerSecond: Math.round((samples * scenario.count * 1000) / total.elapsedMs),
        batchP50Ms: Number(total.latencies[Math.floor(samples * 0.5)].toFixed(3)),
        batchP95Ms: Number(total.latencies[Math.floor(samples * 0.95)].toFixed(3)),
        physicalRequestsPerSample: total.requests / samples,
        requestBodyBytesPerSample: total.requestBytes / samples,
        responseBodyBytesPerSample: total.responseBytes / samples,
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        cpu: cpus()[0]?.model,
        orpc: JSON.parse(await readFile(require.resolve('@orpc/client/package.json'), 'utf8')).version,
        capnweb: JSON.parse(await readFile(resolve(capnPackage, 'package.json'), 'utf8')).version,
        topology: 'One Node process, shared Fetch-to-node:http bridge, real TCP loopback, no TLS, no compression',
        warmupPerEnginePerScenario: warmup,
        samplesPerRound,
        alternatingOrderRounds: rounds,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
