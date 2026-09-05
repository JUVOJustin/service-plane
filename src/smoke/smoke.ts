import {
  type CapabilitySigningJwk,
  cloudflareServiceBinding,
  createCapabilityIssuer,
  defineServiceGrants,
  generateCapabilitySigningSecret,
  httpsService,
  ServicePlaneControlPlane,
} from '../control-plane/index.js';
import {
  type AbilitySchema,
  type CapabilityJwks,
  createAbilityBuilder,
  createAbilityClient,
  createBrokeredAbilityClient,
  defineAbility,
  defineCapabilities,
  jwkCapabilityProofSigner,
  ServicePlaneService,
} from '../service/index.js';
import { publicJwkFromPrivateJwk, servicePlaneJwkThumbprint } from '../shared/jwk-auth.js';
import { signCapabilityProof } from '../shared/proof-of-possession.js';

type SmokeApi = {
  chunks(input: { count: number }): Promise<AsyncIterable<{ index: number }>>;
  run(input: { name: string }): Promise<{ caller: string; name: string }>;
};

export async function runSmoke(): Promise<string[]> {
  const passed: string[] = [];
  const step = (name: string) => passed.push(name);
  const keys = await smokeKeys();
  const capabilities = defineCapabilities({ scopes: [{ id: 'smoke.run' }, { id: 'smoke.stream' }], serviceId: 'smoke' });
  const issuer = createCapabilityIssuer({
    capabilities: [capabilities],
    grants: defineServiceGrants({ grants: [{ caller: 'smoke-caller', scopes: ['smoke.run', 'smoke.stream'], target: 'smoke' }] }),
    issuer: 'control-plane',
    privateJwks: [keys.privateJwk],
  });
  const ability = createAbilityBuilder();
  const jobs = defineAbility({
    id: 'smoke.jobs',
    methods: {
      chunks: ability.stream({
        scopes: ['smoke.stream'],
        input: objectSchema('count', 'number'),
        output: objectSchema('index', 'number'),
        handler: async function* ({ input }) {
          const { count } = input as { count: number };
          for (let index = 0; index < count; index += 1) yield { index };
        },
      }),
      run: ability.method({
        scopes: ['smoke.run'],
        input: objectSchema('name', 'string'),
        output: recordSchema(),
        handler: ({ context, input }) => ({
          caller: context.identity.serviceId,
          name: (input as { name: string }).name,
        }),
      }),
    },
    rpc: { transports: ['fetch', 'service-binding'] },
    scopes: ['smoke.run', 'smoke.stream'],
  });
  const service = new ServicePlaneService({
    ingress: false,
    abilities: [jobs],
    auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] } },
    capabilities,
    id: 'smoke',
    logger: false,
    title: 'Smoke',
    version: '0.0.0',
  });
  const requestToken = (scopes: string[]) =>
    issuer.issueCapabilityToken({ callerAccess: 'service', callerServiceId: 'smoke-caller', scopes, targetServiceId: 'smoke' });
  const fetchTransport = {
    fetch: { fetch: async (request: Request) => service.fetch(request) },
    origin: 'https://smoke.internal',
    type: 'fetch' as const,
  };
  const client = (scopes: string[], request: () => ReturnType<typeof requestToken>, extra: Record<string, unknown> = {}) =>
    createAbilityClient({
      ability: jobs,
      callerServiceId: 'smoke-caller',
      requestToken: request,
      scopes,
      targetServiceId: 'smoke',
      transport: fetchTransport,
      ...extra,
    }) as unknown as SmokeApi;

  const direct = client(['smoke.run', 'smoke.stream'], () => requestToken(['smoke.run', 'smoke.stream']));
  const ran = await direct.run({ name: 'nightly' });
  assert(ran.caller === 'smoke-caller' && ran.name === 'nightly', `unexpected unary result: ${JSON.stringify(ran)}`);
  step('Service Plane Fetch unary call');

  const items: Array<{ index: number }> = [];
  for await (const item of await direct.chunks({ count: 3 })) items.push(item);
  assert(items.map((item) => item.index).join(',') === '0,1,2', `unexpected stream items: ${JSON.stringify(items)}`);
  step('Service Plane Fetch streaming call');

  const native = createAbilityClient({
    ability: jobs,
    callerServiceId: 'smoke-caller',
    requestToken: () => requestToken(['smoke.run']),
    scopes: ['smoke.run'],
    targetServiceId: 'smoke',
    transport: {
      binding: {
        fetch: async (request) => service.fetch(request),
        invokeAbility: (input) => service.invokeAbility(input),
      },
      origin: 'https://smoke.internal',
      type: 'service-binding',
    },
  }) as unknown as Pick<SmokeApi, 'run'>;
  const nativeResult = await native.run({ name: 'native' });
  assert(nativeResult.name === 'native', `native RPC call failed: ${JSON.stringify(nativeResult)}`);
  step('Cloudflare native unary call');

  const issued = await requestToken(['smoke.run']);
  const tampered = issued.token.slice(0, -2) + (issued.token.endsWith('AA') ? 'BB' : 'AA');
  const forged = await client(['smoke.run'], async () => ({ expiresAt: issued.expiresAt, token: tampered }))
    .run({ name: 'forged' })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert(forged instanceof Error, `tampered token was not rejected: ${String(forged)}`);
  step('tampered token rejected');

  const callerKeyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const callerPrivateJwk = await crypto.subtle.exportKey('jwk', callerKeyPair.privateKey);
  const jkt = await servicePlaneJwkThumbprint(publicJwkFromPrivateJwk(callerPrivateJwk, 'smoke-caller-key'));
  const boundToken = () =>
    issuer.issueCapabilityToken({
      callerAccess: 'service',
      callerServiceId: 'smoke-caller',
      confirmation: { jkt },
      scopes: ['smoke.run'],
      targetServiceId: 'smoke',
    });
  const bound = client(['smoke.run'], boundToken, {
    proveTokenPossession: jwkCapabilityProofSigner({ privateJwk: callerPrivateJwk }),
  });
  const proven = await bound.run({ name: 'bound' });
  assert(proven.name === 'bound', `sender-constrained call failed: ${JSON.stringify(proven)}`);

  const otherKeyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const otherPrivateJwk = await crypto.subtle.exportKey('jwk', otherKeyPair.privateKey);
  const wrongKey = await client(['smoke.run'], boundToken, {
    proveTokenPossession: (input: { abilityId: string; targetServiceId: string; token: string }) =>
      signCapabilityProof({ ...input, privateJwk: otherPrivateJwk }),
  })
    .run({ name: 'unbound' })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert(wrongKey instanceof Error, `a proof signed by an unbound key was accepted: ${String(wrongKey)}`);
  step('sender-constrained token proved and refused');

  const refused = await client(['smoke.stream'], () => requestToken(['smoke.run']))
    .chunks({ count: 1 })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert(refused instanceof Error, `missing scope was not refused: ${String(refused)}`);
  step('missing scope refused');

  passed.push(...(await runPlaneSmoke()));

  return passed;
}

// Exercises the public product boundary through both downstream adapters on every smoke runtime.
async function runPlaneSmoke(): Promise<string[]> {
  const secret = await generateCapabilitySigningSecret();
  let plane: ServicePlaneControlPlane;
  const builder = createAbilityBuilder();
  const targets = ['bound', 'hosted'].map((id) => {
    const contract = defineAbility({
      id: `${id}.public`,
      exposure: 'published',
      scopes: ['smoke.run'],
      rpc: { transports: ['fetch', 'service-binding'] },
      methods: {
        echo: builder.method({
          input: objectSchema('name', 'string'),
          output: recordSchema(),
          scopes: ['smoke.run'],
          rest: { method: 'post', path: `/${id}/echo` },
          mcp: { name: `${id}_echo` },
          handler: ({ context, input }) => ({ input, service: id, broker: context.identity.brokerServiceId }),
        }),
      },
    });
    const internal = defineAbility({
      id: `${id}.internal`,
      access: 'service',
      scopes: ['smoke.run'],
      methods: {
        echo: builder.method({
          input: recordSchema(),
          output: recordSchema(),
          scopes: ['smoke.run'],
          mcp: { name: `${id}_internal` },
          handler: () => ({ internal: true }),
        }),
      },
    });
    const service = new ServicePlaneService({
      id,
      title: id,
      version: '1.0.0',
      abilities: [contract, internal],
      capabilities: defineCapabilities({ scopes: [{ id: 'smoke.run' }], serviceId: id }),
      auth: {
        jwks: async () => {
          const response = await plane.fetch(new Request('https://plane.internal/.well-known/service-plane/jwks.json'));
          return response.json() as Promise<CapabilityJwks>;
        },
      },
      logger: false,
    });
    const grants = [{ caller: 'control-plane', scopes: ['smoke.run'] }];
    const endpoint =
      id === 'bound'
        ? cloudflareServiceBinding({
            id,
            binding: { fetch: async (request) => service.fetch(request), invokeAbility: (input) => service.invokeAbility(input) },
            abilityRpc: true,
            grants,
          })
        : httpsService({
            id,
            baseUrl: 'https://hosted.internal',
            fetch: async (url, init) => service.fetch(new Request(url, init)),
            grants,
          });
    return { contract, endpoint, internal };
  });
  plane = new ServicePlaneControlPlane({
    signingKeys: () => [{ kid: 'smoke-plane', secret }],
    services: () => targets.map((target) => target.endpoint),
    broker: {},
    mcp: {},
    log: false,
    invocationMiddleware: async (context, next) => {
      if (context.req.header('authorization') !== 'Bearer smoke-product-caller') return context.text('Unauthorized', 401);
      context.set('servicePlaneCaller', { id: 'smoke-user', kind: 'user' });
      await next();
    },
  });
  const transport = {
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => plane.fetch(new Request(url, init)),
    headers: { authorization: 'Bearer smoke-product-caller' },
  };
  for (const target of targets) {
    const client = createBrokeredAbilityClient({ ability: target.contract, targetServiceId: target.endpoint.id, transport });
    const result = (await client.echo({ name: 'mixed-runtime' })) as Record<string, unknown>;
    assert(result.service === target.endpoint.id && result.broker === 'control-plane', 'broker did not preserve target and ingress');
    const internal = createBrokeredAbilityClient({ ability: target.internal, targetServiceId: target.endpoint.id, transport });
    const refused = await internal.echo({}).then(
      () => false,
      () => true,
    );
    assert(refused, 'product user reached service-only ability');
    const response = await plane.fetch(
      new Request(`https://plane.internal/${target.endpoint.id}/echo`, {
        method: 'POST',
        headers: { ...transport.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'rest' }),
      }),
    );
    assert(response.status === 200, 'projected REST did not reach protected service');
    await response.body?.cancel();
  }
  const tools = await plane.fetch(
    new Request('https://plane.internal/mcp', {
      method: 'POST',
      headers: { ...transport.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
  );
  const listing = (await tools.json()) as { result?: { tools?: Array<{ name: string }> } };
  const names = listing.result?.tools?.map((tool) => tool.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(['bound_echo', 'hosted_echo']), 'MCP exposed private abilities or missed public tools');
  const invocation = await plane.fetch(
    new Request('https://plane.internal/mcp', {
      method: 'POST',
      headers: { ...transport.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hosted_echo', arguments: { name: 'mcp' } } }),
    }),
  );
  const mcp = (await invocation.json()) as { error?: unknown; result?: { isError?: boolean } };
  assert(invocation.status === 200 && !mcp.error && mcp.result !== undefined && !mcp.result.isError, 'MCP invocation failed');
  return ['protected mixed-adapter broker and REST', 'private abilities refused and hidden', 'MCP discovery and protected invocation'];
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`smoke failed: ${message}`);
}

function objectSchema(field: string, kind: 'number' | 'string'): AbilitySchema {
  const jsonSchema = () => ({ properties: { [field]: { type: kind } }, required: [field], type: 'object' });
  return {
    '~standard': {
      jsonSchema: { input: jsonSchema, output: jsonSchema },
      validate: (value: unknown) => {
        const candidate = (value as Record<string, unknown> | null)?.[field];
        const valid = kind === 'number' ? typeof candidate === 'number' : typeof candidate === 'string';
        if (!valid) return { issues: [{ message: `expected ${kind}`, path: [field] }] };
        return { value: { [field]: candidate } };
      },
      vendor: 'smoke',
      version: 1,
    },
  } as AbilitySchema;
}

function recordSchema(): AbilitySchema {
  return {
    '~standard': {
      jsonSchema: { input: () => ({ type: 'object' }), output: () => ({ type: 'object' }) },
      validate: (value: unknown) =>
        typeof value === 'object' && value !== null ? { value } : { issues: [{ message: 'expected object' }] },
      vendor: 'smoke',
      version: 1,
    },
  } as AbilitySchema;
}

async function smokeKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const exported = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const privateJwk: CapabilitySigningJwk = { ...exported, alg: 'ES256', kid: 'smoke-key', use: 'sig' };
  const publicJwk = publicJwkFromPrivateJwk(privateJwk, 'smoke-key');
  return { privateJwk, publicJwk };
}
