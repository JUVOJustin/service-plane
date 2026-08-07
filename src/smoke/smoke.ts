import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/index.js';
import {
  type AbilitySchema,
  abilityMethod,
  abilitySession,
  cloudflareNativeRpc,
  cloudflareServiceBindingRpc,
  defineAbility,
  defineCapabilities,
  disposeAbilitySession,
  jwkCapabilityProofSigner,
  RpcTarget,
  requireScopes,
  ServicePlaneService,
} from '../service/index.js';
// Thumbprinting is not on a public entrypoint — a plane computes `cnf` from the key its caller
// authenticated with, so consumers never call it themselves. The smoke plays both roles.
import { publicJwkFromPrivateJwk, servicePlaneJwkThumbprint } from '../shared/jwk-auth.js';
import { signCapabilityProof } from '../shared/proof-of-possession.js';

// The portability smoke: one self-contained pass over the paths whose behavior differs by runtime,
// written against web-standard globals only so the same bundle runs on Node, workerd, Deno, and Bun.
// It exercises what the CI matrix exists to prove — the HTTP-batch flush (`nextMacrotask` falls back
// to setTimeout(0) where setImmediate is missing: workerd, Deno), the WebCrypto verify path with its
// cached key import, streaming over a session transport, and sender-constrained proofs. Kept out of
// the published build; see tsconfig.json's exclude and scripts/smoke.mjs.

type SmokeApi = {
  chunks(input: { count: number }): Promise<ReadableStream<{ index: number }>>;
  run(input: { name: string }): Promise<{ caller: string; name: string }>;
};

class SmokeHandler extends RpcTarget {
  async *chunks(input: { count: number }) {
    requireScopes(this, 'smoke.stream');
    for (let index = 0; index < input.count; index += 1) yield { index };
  }

  async run(input: { name: string }) {
    const caller = requireScopes(this, 'smoke.run');
    return { caller: caller.serviceId, name: input.name };
  }
}

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
  const service = new ServicePlaneService({
    abilities: [
      defineAbility({
        id: 'smoke.jobs',
        methods: {
          chunks: abilityMethod({
            input: objectSchema('count', 'number'),
            output: objectSchema('index', 'number'),
            scopes: ['smoke.stream'],
            stream: true,
          }),
          run: abilityMethod({
            input: objectSchema('name', 'string'),
            output: recordSchema(),
            scopes: ['smoke.run'],
          }),
        },
        rpc: { transports: ['http-batch', 'cloudflare-binding-rpc'] },
        scopes: ['smoke.run', 'smoke.stream'],
        handler: () => new SmokeHandler() as SmokeHandler & Record<string, unknown>,
      }),
    ],
    auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] } },
    capabilities,
    id: 'smoke',
    // The smoke's one line of output is its verdict; per-request JSON logs would drown it.
    logger: false,
    title: 'Smoke',
    version: '0.0.0',
  });
  const requestToken = (scopes: string[]) =>
    issuer.issueCapabilityToken({ callerAccess: 'service', callerServiceId: 'smoke-caller', scopes, targetServiceId: 'smoke' });

  // HTTP-batch end to end: the one-round-trip transport through the Hono shell, including the
  // batch flush this runtime actually uses (setImmediate on Node/Bun, setTimeout(0) elsewhere).
  const batched = await abilitySession<Pick<SmokeApi, 'run'>>({
    abilityId: 'smoke.jobs',
    callerServiceId: 'smoke-caller',
    requestToken: () => requestToken(['smoke.run']),
    scopes: ['smoke.run'],
    targetServiceId: 'smoke',
    transport: cloudflareServiceBindingRpc({ fetch: async (request) => service.fetch(request) }, undefined, 'https://smoke.internal'),
  });
  const ran = await batched.run({ name: 'nightly' });
  assert(ran.caller === 'smoke-caller' && ran.name === 'nightly', `unexpected unary result: ${JSON.stringify(ran)}`);
  step('http-batch unary call');

  // Streaming over a session transport: native binding RPC keeps the Cap'n Web session open, so the
  // returned ReadableStream flows item by item through the validating wrapper.
  const session = await abilitySession<SmokeApi>({
    abilityId: 'smoke.jobs',
    callerServiceId: 'smoke-caller',
    requestToken: () => requestToken(['smoke.run', 'smoke.stream']),
    scopes: ['smoke.run', 'smoke.stream'],
    targetServiceId: 'smoke',
    transport: cloudflareNativeRpc({ connectAbility: (input) => service.connectAbility(input) }),
  });
  const items: Array<{ index: number }> = [];
  const reader = (await session.chunks({ count: 3 })).getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    items.push(value);
  }
  assert(items.map((item) => item.index).join(',') === '0,1,2', `unexpected stream items: ${JSON.stringify(items)}`);
  disposeAbilitySession(session);
  step('streaming over a session transport');

  // Verify path, negative direction: WebCrypto must reject a tampered signature on this runtime,
  // not just accept a valid one.
  const issued = await requestToken(['smoke.run']);
  const tampered = issued.token.slice(0, -2) + (issued.token.endsWith('AA') ? 'BB' : 'AA');
  const forged = await abilitySession<Pick<SmokeApi, 'run'>>({
    abilityId: 'smoke.jobs',
    callerServiceId: 'smoke-caller',
    requestToken: async () => ({ expiresAt: issued.expiresAt, token: tampered }),
    scopes: ['smoke.run'],
    targetServiceId: 'smoke',
    transport: cloudflareServiceBindingRpc({ fetch: async (request) => service.fetch(request) }, undefined, 'https://smoke.internal'),
  })
    .then((api) => api.run({ name: 'forged' }))
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert(
    forged instanceof Error && forged.message.includes('Invalid Service-Plane capability signature'),
    `tampered token was not rejected: ${String(forged)}`,
  );
  step('tampered token rejected');

  // Sender-constrained tokens: the caller signs a proof with the key its token is bound to. This is
  // the path a runtime JWK-shape difference already broke once — workerd's exportKey('jwk')
  // materializes `alg` where Node omits it — so every runtime has to prove it end to end, in both
  // directions: the bound key accepted, an unbound one refused at the confirmation check.
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

  const bound = await abilitySession<Pick<SmokeApi, 'run'>>({
    abilityId: 'smoke.jobs',
    callerServiceId: 'smoke-caller',
    proveTokenPossession: jwkCapabilityProofSigner({ privateJwk: callerPrivateJwk }),
    requestToken: boundToken,
    scopes: ['smoke.run'],
    targetServiceId: 'smoke',
    transport: cloudflareServiceBindingRpc({ fetch: async (request) => service.fetch(request) }, undefined, 'https://smoke.internal'),
  });
  const proven = await bound.run({ name: 'bound' });
  assert(proven.name === 'bound', `sender-constrained call failed: ${JSON.stringify(proven)}`);

  // The negative direction has to reach the service: the shipped signer refuses a mismatched key
  // locally, so signing directly is what puts the thumbprint check itself under test — and it
  // exercises a second runtime-exported key through the same signing path.
  const otherKeyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const otherPrivateJwk = await crypto.subtle.exportKey('jwk', otherKeyPair.privateKey);
  const wrongKey = await abilitySession<Pick<SmokeApi, 'run'>>({
    abilityId: 'smoke.jobs',
    callerServiceId: 'smoke-caller',
    proveTokenPossession: (input) => signCapabilityProof({ ...input, privateJwk: otherPrivateJwk }),
    requestToken: boundToken,
    scopes: ['smoke.run'],
    targetServiceId: 'smoke',
    transport: cloudflareServiceBindingRpc({ fetch: async (request) => service.fetch(request) }, undefined, 'https://smoke.internal'),
  })
    .then((api) => api.run({ name: 'unbound' }))
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert(
    wrongKey instanceof Error && wrongKey.message.includes('does not match the token confirmation'),
    `a proof signed by an unbound key was accepted: ${String(wrongKey)}`,
  );
  step('sender-constrained token proved and refused');

  // Scope enforcement inside the wrapper: a token without the method's scope must not reach it.
  const narrow = await abilitySession<SmokeApi>({
    abilityId: 'smoke.jobs',
    callerServiceId: 'smoke-caller',
    requestToken: () => requestToken(['smoke.run']),
    scopes: ['smoke.run'],
    targetServiceId: 'smoke',
    transport: cloudflareNativeRpc({ connectAbility: (input) => service.connectAbility(input) }),
  });
  const refused = await narrow.chunks({ count: 1 }).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert(
    refused instanceof Error && refused.message.includes('Missing Service-Plane capability scope'),
    `missing scope was not refused: ${String(refused)}`,
  );
  disposeAbilitySession(narrow);
  step('missing scope refused');

  return passed;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`smoke failed: ${message}`);
}

// Hand-written Standard Schema values keep the smoke free of any validation library, exactly like
// the library itself: `~standard.validate` plus `~standard.jsonSchema` is the whole contract.
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
  const privateJwk = { ...(await crypto.subtle.exportKey('jwk', pair.privateKey)), kid: 'smoke-key' };
  const publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'smoke-key' };
  return { privateJwk, publicJwk };
}
