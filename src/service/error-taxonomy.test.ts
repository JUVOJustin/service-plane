import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import {
  AbilityHandlerError,
  handlerFailureCause,
  rememberHandlerFailureCause,
  ServicePlaneError,
  ServicePlaneTimeoutError,
  servicePlaneErrorInfo,
} from '../shared/errors.js';
import { testKeys } from '../test-support/index.js';
import { abilitySession, cloudflareNativeRpc, defineCapabilities, RpcTarget } from './capabilities.js';
import { type AbilityRpc, abilityMethod, defineAbility } from './discovery.js';
import { ServicePlaneService } from './service.js';

const ISSUED_AT = new Date('2026-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-05-09T12:00:01.000Z');

const capabilities = defineCapabilities({ scopes: [{ id: 'example.work.run' }], serviceId: 'example' });

// Carries something an operator would want in a log and a caller must never see.
class DatabaseError extends Error {
  readonly connectionString = 'postgres://admin:hunter2@db.internal:5432/prod';
  constructor() {
    super('relation "users" does not exist');
    this.name = 'DatabaseError';
  }
}

const workAbility = defineAbility({
  id: 'example.work',
  methods: {
    leaky: abilityMethod({
      input: z.object({}),
      output: z.object({ ok: z.literal(true) }),
      scopes: ['example.work.run'],
    }),
    shaped: abilityMethod({
      input: z.object({}),
      output: z.object({ ok: z.literal(true) }),
      scopes: ['example.work.run'],
    }),
  },
  rpc: { transports: ['http-batch', 'cloudflare-binding-rpc'] },
  scopes: ['example.work.run'],
  handler: () => {
    class WorkApi extends RpcTarget {
      async leaky(): Promise<{ ok: true }> {
        throw new DatabaseError();
      }
      async shaped(): Promise<{ ok: true }> {
        throw new AbilityHandlerError('Monthly export quota is used up', {
          reason: 'quota_exhausted',
          retryable: false,
          status: 429,
        });
      }
    }
    return new WorkApi() as WorkApi & Record<string, unknown>;
  },
});

async function connectedApi() {
  const keys = await testKeys();
  const issuer = createCapabilityIssuer({
    capabilities: [capabilities],
    grants: defineServiceGrants({ grants: [{ caller: 'worker-a', scopes: ['example.work.run'], target: 'example' }] }),
    issuer: 'control-plane',
    now: () => ISSUED_AT,
    privateJwks: [keys.privateJwk],
  });
  const service = new ServicePlaneService({
    abilities: [workAbility],
    auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
    capabilities,
    id: 'example',
    title: 'Example',
    version: '0.1.0',
  });
  const issued = await issuer.issueCapabilityToken({
    callerServiceId: 'worker-a',
    scopes: ['example.work.run'],
    targetServiceId: 'example',
  });
  return abilitySession<AbilityRpc<typeof workAbility>>({
    abilityId: 'example.work',
    callerServiceId: 'worker-a',
    requestToken: async () => issued,
    scopes: ['example.work.run'],
    targetServiceId: 'example',
    transport: cloudflareNativeRpc({ connectAbility: (input) => service.connectAbility(input) }),
  });
}

describe('handler failures crossing the boundary', () => {
  it('replaces an unshaped throw so nothing internal reaches the caller', async () => {
    const api = await connectedApi();
    const caught = await api.leaky({}).then(
      () => undefined,
      (error: unknown) => error,
    );

    const message = (caught as Error).message;
    expect(message).toBe('Service-Plane ability handler failed: leaky');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('users');
    expect(JSON.stringify(caught ?? {})).not.toContain('hunter2');
    expect((caught as { connectionString?: string }).connectionString).toBeUndefined();

    expect(servicePlaneErrorInfo(caught)).toEqual({ code: 'internal', message, retryable: false, status: 500 });
  });

  it('relays a failure the handler shaped on purpose, with its reason and retryability', async () => {
    const api = await connectedApi();
    const caught = await api.shaped({}).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(servicePlaneErrorInfo(caught)).toEqual({
      code: 'handler',
      message: 'Monthly export quota is used up',
      reason: 'quota_exhausted',
      // Explicitly false even though 429 would default to retryable: the handler's word wins.
      retryable: false,
      status: 429,
    });
  });

  it('keeps the original reachable in-process for logging but not on the wire', () => {
    const cause = new DatabaseError();
    const opaque = new ServicePlaneError('Service-Plane ability handler failed: leaky', 500);
    expect(handlerFailureCause(opaque)).toBeUndefined();

    // What the service does internally before handing the replacement to the caller.
    rememberHandlerFailureCause(opaque, cause);
    expect(handlerFailureCause(opaque)).toBe(cause);
    // Held beside the error, so nothing about it can be serialized with it.
    expect(Object.keys(opaque)).not.toContain('cause');
    expect(JSON.stringify(opaque)).not.toContain('hunter2');
  });
});

describe('servicePlaneErrorInfo', () => {
  it('reads the taxonomy from errors this package raises', () => {
    expect(servicePlaneErrorInfo(new ServicePlaneTimeoutError('gone'))).toEqual({
      code: 'timeout',
      message: 'gone',
      // A deadline is transient by nature, so the same call may succeed later.
      retryable: true,
      status: 504,
    });
  });

  it('returns nothing for a value that does not carry the taxonomy', () => {
    for (const value of [undefined, null, 'boom', new Error('boom'), { code: 'made_up', retryable: true, status: 500 }]) {
      expect(servicePlaneErrorInfo(value)).toBeUndefined();
    }
  });

  it('refuses a peer-supplied shape with the wrong types rather than trusting it', () => {
    // A hostile peer must not be able to make a refusal look retryable.
    expect(servicePlaneErrorInfo({ code: 'capability_auth', retryable: 'yes', status: 403 })).toBeUndefined();
    expect(servicePlaneErrorInfo({ code: 'capability_auth', retryable: true, status: '403' })).toBeUndefined();
  });
});
