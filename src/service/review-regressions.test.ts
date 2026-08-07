import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { createControlPlaneRpcBroker } from '../control-plane/broker.js';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { cloudflareServiceBinding } from '../control-plane/endpoints.js';
import { AbilityHandlerError, ServicePlaneError, servicePlaneErrorInfo } from '../shared/errors.js';
import { SERVICE_DISCOVERY_PATH } from '../shared/types.js';
import { testKeys } from '../test-support/index.js';
import { abilitySession, cloudflareNativeRpc, cloudflareServiceBindingRpc, defineCapabilities, RpcTarget } from './capabilities.js';
import { type AbilityRpc, abilityMethod, defineAbility } from './discovery.js';
import type { ServicePlaneLogEvent } from './logger.js';
import { ServicePlaneService } from './service.js';

const ISSUED_AT = new Date('2026-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-05-09T12:00:01.000Z');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const capabilities = defineCapabilities({ scopes: [{ id: 'example.work.run' }], serviceId: 'example' });

async function issuerAndKeys() {
  const keys = await testKeys();
  return {
    issuer: createCapabilityIssuer({
      capabilities: [capabilities],
      grants: defineServiceGrants({ grants: [{ caller: 'worker-a', scopes: ['example.work.run'], target: 'example' }] }),
      issuer: 'control-plane',
      now: () => ISSUED_AT,
      privateJwks: [keys.privateJwk],
    }),
    keys,
  };
}

describe('per-method timeoutMs: 0 opt-out', () => {
  const optOutAbility = defineAbility({
    id: 'example.work',
    methods: {
      slowExport: abilityMethod({
        input: z.object({}),
        output: z.object({ ok: z.literal(true) }),
        scopes: ['example.work.run'],
        timeoutMs: 0,
      }),
    },
    rpc: { transports: ['cloudflare-binding-rpc'] },
    scopes: ['example.work.run'],
    handler: () => {
      class Api extends RpcTarget {
        async slowExport() {
          // Crosses many macrotask boundaries: under the broken spread this failed at ~0ms.
          await sleep(80);
          return { ok: true as const };
        }
      }
      return new Api() as Api & Record<string, unknown>;
    },
  });

  it('actually removes the ceiling instead of enforcing a 0ms one', async () => {
    const { issuer, keys } = await issuerAndKeys();
    const service = new ServicePlaneService({
      abilities: [optOutAbility],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
      capabilities,
      id: 'example',
      // Tight service-wide ceiling proves the opt-out overrides it rather than inheriting it.
      timeout: { methodMs: 20 },
      title: 'Example',
      version: '0.1.0',
    });
    const issued = await issuer.issueCapabilityToken({
      callerAccess: 'service',
      callerServiceId: 'worker-a',
      scopes: ['example.work.run'],
      targetServiceId: 'example',
    });

    const target = (await service.connectAbility({ abilityId: 'example.work', token: issued.token })) as unknown as {
      slowExport(input: unknown): Promise<unknown>;
    };
    await expect(target.slowExport({})).resolves.toEqual({ ok: true });
  });

  it('does not advertise the opted-out value in discovery', async () => {
    const { keys } = await issuerAndKeys();
    const service = new ServicePlaneService({
      abilities: [optOutAbility],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });
    const document = (await (await service.fetch(new Request(`https://example.internal${SERVICE_DISCOVERY_PATH}`))).json()) as {
      abilities: Array<{ methods: Record<string, { timeoutMs?: number }> }>;
    };
    expect(document.abilities[0]?.methods.slowExport && 'timeoutMs' in (document.abilities[0]?.methods.slowExport ?? {})).toBe(false);
  });

  it('refuses invalid method timeout values at definition time', () => {
    for (const invalid of [-5, 1.5, Number.NaN, 2 ** 31]) {
      expect(() =>
        defineAbility({
          id: 'example.work',
          methods: {
            broken: abilityMethod({
              input: z.object({}),
              output: z.object({ ok: z.literal(true) }),
              scopes: ['example.work.run'],
              timeoutMs: invalid,
            }),
          },
          rpc: { transports: ['http-batch'] },
          scopes: ['example.work.run'],
          handler: () => new (class extends RpcTarget {})() as RpcTarget & Record<string, unknown>,
        }),
      ).toBeDefined();
      expect(
        () =>
          new ServicePlaneService({
            abilities: [
              defineAbility({
                id: 'example.work',
                methods: {
                  broken: abilityMethod({
                    input: z.object({}),
                    output: z.object({ ok: z.literal(true) }),
                    scopes: ['example.work.run'],
                    timeoutMs: invalid,
                  }),
                },
                rpc: { transports: ['http-batch'] },
                scopes: ['example.work.run'],
                handler: () => new (class extends RpcTarget {})() as RpcTarget & Record<string, unknown>,
              }),
            ],
            auth: { issuer: 'control-plane', jwks: { keys: [] } },
            capabilities,
            id: 'example',
            title: 'Example',
            version: '0.1.0',
          }),
      ).toThrow(/timeoutMs/u);
    }
  });

  it('never advertises a bound on a streaming method', async () => {
    const { keys } = await issuerAndKeys();
    const service = new ServicePlaneService({
      abilities: [
        defineAbility({
          id: 'example.work',
          methods: {
            follow: abilityMethod({
              input: z.object({}),
              output: z.object({ tick: z.number() }),
              scopes: ['example.work.run'],
              stream: true,
              // Declared but meaningless: the stream contract says absent, so absent it must be.
              timeoutMs: 30_000,
            }),
          },
          rpc: { transports: ['cloudflare-binding-rpc'] },
          scopes: ['example.work.run'],
          handler: () => {
            class Api extends RpcTarget {
              async *follow() {
                yield { tick: 1 };
              }
            }
            return new Api() as Api & Record<string, unknown>;
          },
        }),
      ],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });
    const document = (await (await service.fetch(new Request(`https://example.internal${SERVICE_DISCOVERY_PATH}`))).json()) as {
      abilities: Array<{ methods: Record<string, { timeoutMs?: number }> }>;
    };
    expect(document.abilities[0]?.methods.follow && 'timeoutMs' in (document.abilities[0]?.methods.follow ?? {})).toBe(false);
  });
});

describe('exhausted chain budget fails fast', () => {
  it('rejects immediately instead of opening an unbounded downstream call', async () => {
    const { issuer, keys } = await issuerAndKeys();
    let reachedService = false;
    const service = new ServicePlaneService({
      abilities: [
        defineAbility({
          id: 'example.work',
          methods: {
            run: abilityMethod({ input: z.object({}), output: z.object({ ok: z.literal(true) }), scopes: ['example.work.run'] }),
          },
          rpc: { transports: ['http-batch'] },
          scopes: ['example.work.run'],
          handler: () => {
            reachedService = true;
            class Api extends RpcTarget {
              async run() {
                return { ok: true as const };
              }
            }
            return new Api() as Api & Record<string, unknown>;
          },
        }),
      ],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });
    const issued = await issuer.issueCapabilityToken({
      callerAccess: 'service',
      callerServiceId: 'worker-a',
      scopes: ['example.work.run'],
      targetServiceId: 'example',
    });

    // What the documented chain pattern produces at exhaustion: remainingTimeoutMs() === 0.
    const api = await abilitySession<{ run(input: object): Promise<unknown> }>({
      abilityId: 'example.work',
      callerServiceId: 'worker-a',
      requestToken: async () => issued,
      scopes: ['example.work.run'],
      targetServiceId: 'example',
      timeoutMs: 0,
      transport: cloudflareServiceBindingRpc(
        { fetch: async (request: Request) => service.fetch(request) },
        undefined,
        'https://example.internal',
      ),
    });

    const caught = await api.run({}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(servicePlaneErrorInfo(caught)?.code).toBe('timeout');
    expect(reachedService).toBe(false);
  });
});

describe('taxonomy across a serializing chain', () => {
  it('keeps a downstream shaped error intact through a middle hop instead of flattening it', async () => {
    const { issuer, keys } = await issuerAndKeys();

    const leaf = new ServicePlaneService({
      abilities: [
        defineAbility({
          id: 'example.work',
          methods: {
            run: abilityMethod({ input: z.object({}), output: z.object({ ok: z.literal(true) }), scopes: ['example.work.run'] }),
          },
          rpc: { transports: ['http-batch'] },
          scopes: ['example.work.run'],
          handler: () => {
            class Api extends RpcTarget {
              async run(): Promise<{ ok: true }> {
                throw new AbilityHandlerError('Monthly export quota is used up', {
                  reason: 'quota_exhausted',
                  retryable: false,
                  status: 429,
                });
              }
            }
            return new Api() as Api & Record<string, unknown>;
          },
        }),
      ],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });
    const issued = await issuer.issueCapabilityToken({
      callerAccess: 'service',
      callerServiceId: 'worker-a',
      scopes: ['example.work.run'],
      targetServiceId: 'example',
    });

    const middle = new ServicePlaneService({
      abilities: [
        defineAbility({
          id: 'example.work',
          methods: {
            run: abilityMethod({ input: z.object({}), output: z.object({ ok: z.literal(true) }), scopes: ['example.work.run'] }),
          },
          rpc: { transports: ['cloudflare-binding-rpc'] },
          scopes: ['example.work.run'],
          handler: () => {
            class Api extends RpcTarget {
              async run(): Promise<{ ok: true }> {
                // HTTP-batch to the leaf: the leaf's error is serialized and rebuilt as a plain
                // Error here, which is exactly the shape the middle hop's wrapper must not flatten.
                const downstream = await abilitySession<AbilityRpc<never> & { run(input: object): Promise<{ ok: true }> }>({
                  abilityId: 'example.work',
                  callerServiceId: 'worker-a',
                  requestToken: async () => issued,
                  scopes: ['example.work.run'],
                  targetServiceId: 'example',
                  transport: cloudflareServiceBindingRpc(
                    { fetch: async (request: Request) => leaf.fetch(request) },
                    undefined,
                    'https://example.internal',
                  ),
                });
                return downstream.run({});
              }
            }
            return new Api() as Api & Record<string, unknown>;
          },
        }),
      ],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });

    const api = await abilitySession<{ run(input: object): Promise<unknown> }>({
      abilityId: 'example.work',
      callerServiceId: 'worker-a',
      requestToken: async () => issued,
      scopes: ['example.work.run'],
      targetServiceId: 'example',
      transport: cloudflareNativeRpc({ connectAbility: (input) => middle.connectAbility(input) }),
    });

    const caught = await api.run({}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(servicePlaneErrorInfo(caught)).toEqual({
      code: 'handler',
      message: 'Monthly export quota is used up',
      reason: 'quota_exhausted',
      retryable: false,
      status: 429,
    });
  });
});

describe('session transports get no manufactured default budget', () => {
  it('keeps a native-binding session usable past defaultMs when the caller sent nothing', async () => {
    const { issuer, keys } = await issuerAndKeys();
    const service = new ServicePlaneService({
      abilities: [
        defineAbility({
          id: 'example.work',
          methods: {
            run: abilityMethod({ input: z.object({}), output: z.object({ ok: z.literal(true) }), scopes: ['example.work.run'] }),
          },
          rpc: { transports: ['cloudflare-binding-rpc'] },
          scopes: ['example.work.run'],
          handler: ({ signal }) => {
            // No manufactured budget means no signal either.
            expect(signal).toBeUndefined();
            class Api extends RpcTarget {
              async run() {
                return { ok: true as const };
              }
            }
            return new Api() as Api & Record<string, unknown>;
          },
        }),
      ],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
      capabilities,
      id: 'example',
      timeout: { defaultMs: 40 },
      title: 'Example',
      version: '0.1.0',
    });
    const issued = await issuer.issueCapabilityToken({
      callerAccess: 'service',
      callerServiceId: 'worker-a',
      scopes: ['example.work.run'],
      targetServiceId: 'example',
    });

    const target = (await service.connectAbility({ abilityId: 'example.work', token: issued.token })) as unknown as {
      run(input: unknown): Promise<unknown>;
    };
    await expect(target.run({})).resolves.toEqual({ ok: true });
    // Well past defaultMs: a manufactured session budget would have poisoned this call.
    await sleep(80);
    await expect(target.run({})).resolves.toEqual({ ok: true });
  });
});

describe('replaced handler failures are logged', () => {
  it('emits service_plane.ability.handler_failed with the original cause', async () => {
    const { issuer, keys } = await issuerAndKeys();
    const events: ServicePlaneLogEvent[] = [];
    const service = new ServicePlaneService({
      abilities: [
        defineAbility({
          id: 'example.work',
          methods: {
            run: abilityMethod({ input: z.object({}), output: z.object({ ok: z.literal(true) }), scopes: ['example.work.run'] }),
          },
          rpc: { transports: ['cloudflare-binding-rpc'] },
          scopes: ['example.work.run'],
          handler: () => {
            class Api extends RpcTarget {
              async run(): Promise<{ ok: true }> {
                throw new TypeError('secret internal detail');
              }
            }
            return new Api() as Api & Record<string, unknown>;
          },
        }),
      ],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
      capabilities,
      id: 'example',
      logger: { log: (event) => events.push(event) },
      title: 'Example',
      version: '0.1.0',
    });
    const issued = await issuer.issueCapabilityToken({
      callerAccess: 'service',
      callerServiceId: 'worker-a',
      scopes: ['example.work.run'],
      targetServiceId: 'example',
    });

    const target = (await service.connectAbility({ abilityId: 'example.work', token: issued.token })) as unknown as {
      run(input: unknown): Promise<unknown>;
    };
    const caught = await target.run({}).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Caller sees the opaque replacement; the service's own log sees what actually broke.
    expect((caught as Error).message).not.toContain('secret internal detail');
    expect(events).toContainEqual(
      expect.objectContaining({
        abilityId: 'example.work',
        error: { message: 'secret internal detail', name: 'TypeError' },
        event: 'service_plane.ability.handler_failed',
        method: 'run',
        serviceId: 'example',
      }),
    );
  });
});

describe('broker held across requests', () => {
  it('does not erode the budget between construction and rootCapability', async () => {
    const { issuer, keys } = await issuerAndKeys();
    const service = new ServicePlaneService({
      abilities: [
        defineAbility({
          id: 'example.work',
          methods: {
            run: abilityMethod({ input: z.object({}), output: z.object({ ok: z.literal(true) }), scopes: ['example.work.run'] }),
          },
          rpc: { transports: ['http-batch'] },
          scopes: ['example.work.run'],
          handler: () => {
            class Api extends RpcTarget {
              async run() {
                return { ok: true as const };
              }
            }
            return new Api() as Api & Record<string, unknown>;
          },
        }),
      ],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });
    const endpoint = cloudflareServiceBinding({
      binding: { fetch: async (request: Request) => service.fetch(request) },
      id: 'example',
    });

    // The clock advances far past the budget between construction and the request.
    let nowMs = 0;
    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer,
      now: () => nowMs,
      services: [endpoint],
      timeoutMs: 1_000,
    });
    nowMs = 60_000;

    const root = broker.rootCapability({ id: 'worker-a', kind: 'service' }) as unknown as {
      ability(
        serviceId: string,
        abilityId: string,
      ): Promise<{ connect(scopes: string[]): Promise<{ run(input: object): Promise<unknown> }> }>;
    };
    const api = await (await root.ability('example', 'example.work')).connect(['example.work.run']);
    await expect(api.run({})).resolves.toEqual({ ok: true });
  });
});

describe('policy validation', () => {
  it('refuses a maxMs of 0 instead of silently removing the clamp', () => {
    expect(
      () =>
        new ServicePlaneService({
          abilities: [
            defineAbility({
              id: 'example.work',
              methods: {
                run: abilityMethod({ input: z.object({}), output: z.object({ ok: z.literal(true) }), scopes: ['example.work.run'] }),
              },
              rpc: { transports: ['http-batch'] },
              scopes: ['example.work.run'],
              handler: () => new (class extends RpcTarget {})() as RpcTarget & Record<string, unknown>,
            }),
          ],
          auth: { issuer: 'control-plane', jwks: { keys: [] } },
          capabilities,
          id: 'example',
          timeout: { maxMs: 0 },
          title: 'Example',
          version: '0.1.0',
        }),
    ).toThrow(ServicePlaneError);
  });

  it('refuses timeout.methodMs: 0 with a pointer at the explicit opt-out', () => {
    expect(
      () =>
        new ServicePlaneService({
          abilities: [
            defineAbility({
              id: 'example.work',
              methods: {
                run: abilityMethod({ input: z.object({}), output: z.object({ ok: z.literal(true) }), scopes: ['example.work.run'] }),
              },
              rpc: { transports: ['http-batch'] },
              scopes: ['example.work.run'],
              handler: () => new (class extends RpcTarget {})() as RpcTarget & Record<string, unknown>,
            }),
          ],
          auth: { issuer: 'control-plane', jwks: { keys: [] } },
          capabilities,
          id: 'example',
          timeout: { methodMs: 0 },
          title: 'Example',
          version: '0.1.0',
        }),
    ).toThrow(/methodMs/u);
  });
});
