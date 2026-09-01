import { call } from '@orpc/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { servicePlaneErrorInfo } from '../shared/errors.js';
import type { CapabilityIdentity, CapabilityJwks } from '../shared/types.js';
import { testKeys } from '../test-support/index.js';
import { type AbilityMethodContext, createAbilityBuilder } from './ability.js';
import { defineCapabilities } from './capabilities.js';
import { defineAbility } from './discovery.js';
import { compileAbilityMethod, createAbilityRpcRuntimeContext } from './orpc.js';
import { ServicePlaneService } from './service.js';

const NOW = new Date('2099-05-09T12:00:00.000Z');

describe('service authorization deadlines', () => {
  it('times out a pending JWKS resolver and never starts the handler after a late resolution', async () => {
    const keys = await testKeys();
    const capabilities = defineCapabilities({ scopes: [{ id: 'tasks.read' }], serviceId: 'tasks' });
    const issuer = createCapabilityIssuer({
      capabilities: [capabilities],
      grants: defineServiceGrants({ grants: [{ caller: 'worker-a', scopes: ['tasks.read'], target: 'tasks' }] }),
      issuer: 'control-plane',
      now: () => NOW,
      privateJwks: [keys.privateJwk],
    });
    const issued = await issuer.issueCapabilityToken({
      callerAccess: 'service',
      callerServiceId: 'worker-a',
      scopes: ['tasks.read'],
      targetServiceId: 'tasks',
    });
    let resolveJwks: ((jwks: CapabilityJwks) => void) | undefined;
    const pendingJwks = new Promise<CapabilityJwks>((resolve) => {
      resolveJwks = resolve;
    });
    let authorizationSignal: AbortSignal | undefined;
    let handlerRuns = 0;
    const ability = createAbilityBuilder();
    const tasks = defineAbility({
      id: 'tasks.items',
      methods: {
        get: ability.method({
          handler: () => {
            handlerRuns += 1;
            return { ok: true };
          },
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          scopes: ['tasks.read'],
        }),
      },
      rpc: { transports: ['service-binding'] },
      scopes: ['tasks.read'],
    });
    const service = new ServicePlaneService({
      abilities: [tasks],
      auth: {
        issuer: 'control-plane',
        jwks: (context) => {
          authorizationSignal = context.req.raw.signal;
          return pendingJwks;
        },
        now: () => NOW,
      },
      capabilities,
      id: 'tasks',
      logger: false,
      timeout: { methodMs: 20 },
      title: 'Tasks',
      version: '1.0.0',
    });

    const error = await service
      .invokeAbility({
        abilityId: 'tasks.items',
        input: {},
        method: 'get',
        token: issued.token,
      })
      .catch((cause: unknown) => cause);

    expect(servicePlaneErrorInfo(error)).toMatchObject({ code: 'timeout', status: 504 });
    expect(authorizationSignal?.aborted).toBe(true);
    expect(servicePlaneErrorInfo(authorizationSignal?.reason)).toMatchObject({ code: 'timeout', status: 504 });
    expect(handlerRuns).toBe(0);

    resolveJwks?.({ keys: [keys.publicJwk] });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(handlerRuns).toBe(0);
  });

  it('applies a caller deadline to streaming authorization without adding a method ceiling', async () => {
    let handlerRuns = 0;
    const method = createAbilityBuilder().stream({
      handler: async function* () {
        handlerRuns += 1;
        yield 'ready';
      },
      input: z.object({}),
      output: z.string(),
    });
    const identity: CapabilityIdentity = {
      audience: 'tasks',
      callerAccess: 'service',
      expiresAt: new Date(Date.now() + 60_000),
      issuer: 'control-plane',
      scopes: [],
      serviceId: 'worker-a',
      tokenId: 'cap-stream',
    };
    const methodContext = {
      abilityId: 'tasks.items',
      context: {} as AbilityMethodContext['context'],
      env: {},
      identity,
      methodName: 'watch',
      request: new Request('https://tasks.internal/rpc/tasks.items/watch'),
    } satisfies AbilityMethodContext;
    let resolveAuthorization: ((value: { context: typeof methodContext; deadlineAt: number }) => void) | undefined;
    const authorization = new Promise<{ context: typeof methodContext; deadlineAt: number }>((resolve) => {
      resolveAuthorization = resolve;
    });
    const deadlineAt = Date.now() + 20;
    const runtime = createAbilityRpcRuntimeContext({
      authorize: () => authorization,
      resolveDeadlineAt: () => deadlineAt,
    });

    const error = await call(compileAbilityMethod(method), {}, { context: runtime }).catch((cause: unknown) => cause);

    expect(servicePlaneErrorInfo(error)).toMatchObject({ code: 'timeout', status: 504 });
    resolveAuthorization?.({ context: methodContext, deadlineAt });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handlerRuns).toBe(0);
  });
});
