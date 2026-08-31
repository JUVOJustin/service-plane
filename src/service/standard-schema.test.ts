import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { ServicePlaneClientError } from '../shared/errors.js';
import { testKeys } from '../test-support/index.js';
import { type AbilitySchema, createAbilityBuilder } from './ability.js';
import { defineCapabilities } from './capabilities.js';
import { createAbilityClient } from './client.js';
import { type AbilityMethodDefinitions, defineAbility, serviceDiscoveryDocument } from './discovery.js';
import { ServicePlaneService } from './service.js';

const ISSUED_AT = new Date('2026-08-20T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-08-20T12:00:01.000Z');

// A hand-written vendor: proves abilities depend on the Standard Schema contracts only, with no
// validation library involved. Real services use Zod, ArkType, Valibot, VineJS, or similar.
function stringField<TField extends string>(field: TField): StandardSchemaV1<Record<TField, string>> & StandardJSONSchemaV1 {
  const render = () => ({ properties: { [field]: { type: 'string' } }, required: [field], type: 'object' });
  return {
    '~standard': {
      jsonSchema: { input: render, output: render },
      validate: (value: unknown) => {
        const candidate = (value as Record<string, unknown> | null)?.[field];
        if (typeof candidate !== 'string') {
          return { issues: [{ message: 'Invalid input: expected string', path: [field] }] };
        }
        return { value: { [field]: candidate } as Record<TField, string> };
      },
      vendor: 'handwritten',
      version: 1,
    },
  };
}

// Builds a schema whose validator deviates from the contract, to prove the pipeline fails closed
// rather than handing a handler unvalidated data. The JSON Schema half stays valid so the schema
// survives definition-time checks and the degenerate behaviour is exercised on a live call.
function malformedSchema(validate: (value: unknown) => unknown): AbilitySchema {
  const render = () => ({ type: 'object' });
  return {
    '~standard': { jsonSchema: { input: render, output: render }, validate, vendor: 'malformed', version: 1 },
  } as unknown as AbilitySchema;
}

const ability = createAbilityBuilder();

async function serve<TMethods extends AbilityMethodDefinitions>(methods: TMethods) {
  const keys = await testKeys();
  const capabilities = defineCapabilities({ scopes: [{ id: 'notes.read' }], serviceId: 'notes' });
  const issuer = createCapabilityIssuer({
    capabilities: [capabilities],
    grants: defineServiceGrants({ grants: [{ caller: 'headless-front', scopes: ['notes.read'], target: 'notes' }] }),
    issuer: 'control-plane',
    now: () => ISSUED_AT,
    privateJwks: [keys.privateJwk],
  });
  const issued = await issuer.issueCapabilityToken({
    callerAccess: 'service',
    callerServiceId: 'headless-front',
    scopes: ['notes.read'],
    targetServiceId: 'notes',
  });
  const notes = defineAbility({ id: 'notes.items', methods, rpc: { transports: ['fetch'] }, scopes: ['notes.read'] });
  const service = new ServicePlaneService({
    abilities: [notes],
    auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
    capabilities,
    id: 'notes',
    logger: false,
    title: 'Notes',
    version: '1.0.0',
  });
  const client = createAbilityClient({
    ability: notes,
    callerServiceId: 'headless-front',
    requestToken: async () => issued,
    scopes: ['notes.read'],
    targetServiceId: 'notes',
    transport: {
      fetch: async (url, init) => service.fetch(new Request(url, init)),
      origin: 'https://notes.internal',
      type: 'fetch',
    },
  });
  return { client, service };
}

describe('standard schema abilities over the Service Plane client', () => {
  it('runs a hand-rolled non-Zod Standard Schema end to end as input and output', async () => {
    const { client, service } = await serve({
      get: ability
        .method({ scopes: ['notes.read'] })
        .input(stringField('query'))
        .output(stringField('result'))
        .handler(({ input }) => ({ result: input.query })),
    });

    await expect(client.get({ query: 'hi' })).resolves.toEqual({ result: 'hi' });

    // Discovery renders the hand-rolled `~standard.jsonSchema`, so no library is in that path either.
    const doc = serviceDiscoveryDocument(service.definition);
    expect(doc.abilities[0]?.methods.get?.inputSchema).toEqual({
      properties: { query: { type: 'string' } },
      required: ['query'],
      type: 'object',
    });
    expect(doc.abilities[0]?.methods.get?.outputSchema).toEqual({
      properties: { result: { type: 'string' } },
      required: ['result'],
      type: 'object',
    });
  });

  it('refuses input the hand-rolled vendor rejects with structured 422 issues', async () => {
    let handlerRan = false;
    const { client } = await serve({
      get: ability
        .method({ scopes: ['notes.read'] })
        .input(stringField('query'))
        .output(stringField('result'))
        .handler(({ input }) => {
          handlerRan = true;
          return { result: input.query };
        }),
    });

    const error = await client.get({ query: 7 } as never).catch((caught: unknown) => caught);
    expect(handlerRan).toBe(false);
    expect(error).toBeInstanceOf(ServicePlaneClientError);
    expect(error).toMatchObject({
      code: 'ability_validation',
      issues: [{ message: 'Invalid input: expected string', path: ['query'] }],
      message: 'Service-Plane ability input for get: query: Invalid input: expected string',
      retryable: false,
      status: 422,
    });
  });

  it('treats a throwing validator as a refusal without running the handler or leaking the throw', async () => {
    let handlerRan = false;
    const { client } = await serve({
      get: ability
        .method({ scopes: ['notes.read'] })
        .input(
          malformedSchema(() => {
            throw new Error('validator exploded: db=secret-internal');
          }),
        )
        .output(z.object({ result: z.string() }))
        .handler(() => {
          handlerRan = true;
          return { result: 'ok' };
        }),
    });

    const error = await client.get({ query: 'hi' }).catch((caught: unknown) => caught);
    expect(handlerRan).toBe(false);
    expect(error).toBeInstanceOf(ServicePlaneClientError);
    // The throw is replaced by the opaque handler-failure error: the caller learns nothing about
    // what the validator was doing when it blew up.
    expect(error).toMatchObject({
      code: 'internal',
      message: 'Service-Plane ability handler failed: get',
      retryable: false,
      status: 500,
    });
    expect((error as Error).message).not.toContain('secret-internal');
    expect(JSON.stringify(error)).not.toContain('secret-internal');
  });

  // oRPC's own validateInput checks only `result.issues`, so without the fail-closed schema guard
  // a degenerate validator result like `{}` would count as success with `value: undefined` and the
  // handler would run on unvalidated input.
  it('fails closed when a validator returns neither value nor issues', async () => {
    let handlerRan = false;
    const { client } = await serve({
      get: ability
        .method({ scopes: ['notes.read'] })
        .input(malformedSchema(() => ({})))
        .output(z.object({ result: z.string() }))
        .handler(() => {
          handlerRan = true;
          return { result: 'ok' };
        }),
    });

    const error = await client.get({ query: 'hi' }).catch((caught: unknown) => caught);
    expect(handlerRan).toBe(false);
    expect(error).toBeInstanceOf(ServicePlaneClientError);
    expect(error).toMatchObject({
      code: 'ability_validation',
      retryable: false,
      status: 422,
    });
    expect((error as Error).message).toContain('neither a value nor issues');
  });

  it('replaces a handler output the schema rejects with an opaque 500', async () => {
    const { client } = await serve({
      get: ability
        .method({ scopes: ['notes.read'] })
        .input(z.object({ query: z.string() }))
        .output(z.object({ result: z.number() }))
        .handler(() => ({ result: 'secret-row-data' as unknown as number })),
    });

    const error = await client.get({ query: 'hi' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServicePlaneClientError);
    expect(error).toMatchObject({
      code: 'ability_validation',
      message: 'Service-Plane ability output for get failed validation',
      retryable: false,
      status: 500,
    });
    expect((error as Error).message).not.toContain('secret-row-data');
    expect(JSON.stringify(error)).not.toContain('secret-row-data');
  });

  it('terminates a stream when a yielded item fails the per-item output schema', async () => {
    const { client } = await serve({
      watch: ability
        .stream(stringField('result'), { scopes: ['notes.read'] })
        .input(z.object({ after: z.number() }))
        .handler(async function* () {
          yield { result: 'ok' };
          yield { result: 1729 } as unknown as { result: string };
          yield { result: 'never reached' };
        }),
    });

    const stream = await client.watch({ after: 0 });
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { result: 'ok' } });
    const error = await iterator.next().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServicePlaneClientError);
    expect(error).toMatchObject({ code: 'ability_validation', status: 500 });
    expect((error as Error).message).not.toContain('1729');
  });
});
