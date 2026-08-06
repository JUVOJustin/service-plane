import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import type { CapabilityIdentity } from '../shared/types.js';
import { demoService, drainStream, nativeRpcEnv, testKeys } from '../test-support/index.js';
import { abilitySession, cloudflareNativeRpc, defineCapabilities, RpcTarget } from './capabilities.js';
import {
  type AbilitySchema,
  abilityMethod,
  createValidatingAbilityHandler,
  defineAbility,
  defineAbilityService,
  serviceDiscoveryDocument,
} from './discovery.js';

// A hand-written vendor: proves abilities depend on the Standard Schema contracts only, with no
// validation library involved. Real services use Zod, ArkType, Valibot, VineJS, or similar.
// `targets` records what Service Plane asked each converter for, so the requested JSON Schema
// dialect is asserted rather than inferred from a vendor whose default happens to match.
function stringField(field: string, targets: string[] = []): AbilitySchema {
  const render = (options: { target: string }) => {
    targets.push(options.target);
    return { properties: { [field]: { type: 'string' } }, required: [field], type: 'object' };
  };
  return {
    '~standard': {
      jsonSchema: { input: render, output: render },
      validate: (value: unknown) => {
        const candidate = (value as Record<string, unknown> | null)?.[field];
        if (typeof candidate !== 'string') {
          return { issues: [{ message: 'Invalid input: expected string', path: [field] }] };
        }
        return { value: { [field]: candidate } };
      },
      vendor: 'handwritten',
      version: 1,
    },
  } as AbilitySchema;
}

// Builds a schema whose `~standard` deviates from the contract, to prove the wrapper fails
// closed rather than handing a handler unvalidated data.
function malformedSchema(props: Record<string, unknown>): AbilitySchema {
  return { '~standard': { vendor: 'malformed', version: 1, ...props } } as unknown as AbilitySchema;
}

const jsonSchemaOnly = () => ({ type: 'object' });

const capabilities = defineCapabilities({ scopes: [{ id: 'example.search' }], serviceId: 'example' });

const identity: CapabilityIdentity = {
  audience: 'example',
  callerAccess: 'service',
  expiresAt: new Date('2100-01-01T00:00:00Z'),
  issuer: 'control-plane',
  scopes: ['example.search'],
  serviceId: 'caller',
  tokenId: 'cap_1',
};

class EchoHandler extends RpcTarget {
  search(input: { query: string }) {
    return { result: input.query };
  }
}

const searchService = (input: AbilitySchema, output: AbilitySchema) =>
  defineAbilityService({
    abilities: [
      defineAbility({
        exposure: 'published',
        id: 'example.search',
        methods: {
          search: abilityMethod({
            input,
            output,
            rest: { method: 'get', path: '/examples/search', summary: 'Search' },
            scopes: ['example.search'],
          }),
        },
        scopes: ['example.search'],
        handler: () => new EchoHandler() as EchoHandler & Record<string, unknown>,
      }),
    ],
    capabilities,
    id: 'example',
    title: 'Example',
    version: '0.1.0',
  });

// Streaming re-validates every item as the consumer pulls, so a vendor is exercised per item
// rather than once per call.
class StreamHandler extends RpcTarget {
  cancelled = false;
  pulled = 0;

  async *listChunks() {
    try {
      for (const chunk of ['a', 'b', 'c']) {
        this.pulled += 1;
        yield { result: chunk };
      }
    } finally {
      this.cancelled = true;
    }
  }

  async *badItem() {
    yield { result: 'ok' };
    yield { result: 7 } as unknown as { result: string };
    yield { result: 'never reached' };
  }
}

const streamService = (output: AbilitySchema) =>
  defineAbilityService({
    abilities: [
      defineAbility({
        exposure: 'published',
        id: 'example.search',
        methods: {
          badItem: abilityMethod({ input: stringField('query'), output, scopes: ['example.search'], stream: true }),
          listChunks: abilityMethod({ input: stringField('query'), output, scopes: ['example.search'], stream: true }),
        },
        rpc: { transports: ['websocket'] },
        scopes: ['example.search'],
        handler: () => new StreamHandler() as StreamHandler & Record<string, unknown>,
      }),
    ],
    capabilities,
    id: 'example',
    title: 'Example',
    version: '0.1.0',
  });

function streamHandlerFor(output: AbilitySchema, handler: StreamHandler) {
  const ability = streamService(output).abilities[0];
  if (!ability) throw new Error('missing ability');
  return createValidatingAbilityHandler(ability, handler as StreamHandler & Record<string, unknown>, identity, {
    allowStreaming: true,
  }) as unknown as {
    badItem(input: { query: string }): Promise<ReadableStream<{ result: string }>>;
    listChunks(input: { query: string }): Promise<ReadableStream<{ result: string }>>;
  };
}

function searchHandler(input: AbilitySchema, output: AbilitySchema) {
  const ability = searchService(input, output).abilities[0];
  if (!ability) throw new Error('missing ability');
  return createValidatingAbilityHandler(ability, new EchoHandler() as EchoHandler & Record<string, unknown>, identity) as unknown as {
    search(input: unknown): Promise<unknown>;
  };
}

describe('standard schema streaming', () => {
  it('validates every streamed item through a non-Zod vendor', async () => {
    const source = new StreamHandler();
    const handler = streamHandlerFor(stringField('result'), source);

    await expect(drainStream(await handler.listChunks({ query: 'go' }))).resolves.toEqual([
      { result: 'a' },
      { result: 'b' },
      { result: 'c' },
    ]);
  });

  it('errors the stream on the first item the vendor rejects', async () => {
    const handler = streamHandlerFor(stringField('result'), new StreamHandler());
    const stream = await handler.badItem({ query: 'go' });
    const reader = stream.getReader();

    await expect(reader.read()).resolves.toEqual({ done: false, value: { result: 'ok' } });
    await expect(reader.read()).rejects.toThrow('Service-Plane ability stream item for badItem: result: Invalid input');
  });

  // Not runnable on workerd: its ReadableStream pulls one element ahead of the reader (a legal
  // high-water-mark choice), so the exact pulled-count pin holds only on Node. Laziness itself is
  // still covered there — the eager-drain failure mode this guards against would pull all items,
  // and the badItem/cancel tests above run on both runtimes.
  it.skipIf(typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers')(
    'validates lazily so consumer backpressure still reaches the handler',
    async () => {
      const source = new StreamHandler();
      const handler = streamHandlerFor(stringField('result'), source);
      const reader = (await handler.listChunks({ query: 'go' })).getReader();

      await reader.read();
      expect(source.pulled).toBe(1);

      await reader.cancel('done early');
      await expect(reader.closed).resolves.toBeUndefined();
      expect(source.pulled).toBe(1);
      // The generator's finally block ran, so the handler's cleanup is not stranded.
      expect(source.cancelled).toBe(true);
    },
  );

  it('matches Zod streaming behaviour item for item', async () => {
    const zodOutput = z.object({ result: z.string() });
    await expect(drainStream(await streamHandlerFor(zodOutput, new StreamHandler()).listChunks({ query: 'go' }))).resolves.toEqual([
      { result: 'a' },
      { result: 'b' },
      { result: 'c' },
    ]);

    const failing = await streamHandlerFor(zodOutput, new StreamHandler()).badItem({ query: 'go' });
    await expect(drainStream(failing)).rejects.toThrow('Service-Plane ability stream item for badItem');
  });

  it('rejects a streaming method whose item schema cannot render JSON Schema', () => {
    expect(() => streamService(z.object({ result: z.string() }).transform((value) => value.result))).toThrow(
      /cannot be represented as JSON Schema for example\.search\/badItem/u,
    );
  });
});

// End-to-end over a real Cap'n Web session transport: the wrapper tests above stop at the
// handler, this one carries validated items across the RPC boundary.
describe('standard schema streaming over a session transport', () => {
  const ISSUED_AT = new Date('2026-07-22T12:00:00.000Z');
  const VERIFIED_AT = new Date('2026-07-22T12:00:01.000Z');

  async function createFixture() {
    const keys = await testKeys();
    const deployed = demoService({
      env: nativeRpcEnv(),
      issuer: 'control-plane',
      jwks: { keys: [keys.publicJwk] },
      now: () => VERIFIED_AT,
      spec: {
        abilities: () => [
          defineAbility({
            id: 'example.stream',
            methods: {
              badItem: abilityMethod({
                input: stringField('query'),
                output: stringField('result'),
                scopes: ['example.read'],
                stream: true,
              }),
              listChunks: abilityMethod({
                input: stringField('query'),
                output: stringField('result'),
                scopes: ['example.read'],
                stream: true,
              }),
            },
            rpc: { transports: ['cloudflare-binding-rpc'] },
            scopes: ['example.read'],
            handler: () => new StreamHandler() as StreamHandler & Record<string, unknown>,
          }),
        ],
        id: 'example',
        scopes: ['example.read'],
        title: 'Example',
      },
    });
    const issuer = createCapabilityIssuer({
      capabilities: [deployed.capabilities],
      grants: defineServiceGrants({ grants: [{ caller: 'worker-a', scopes: ['example.read'], target: 'example' }] }),
      issuer: 'control-plane',
      now: () => ISSUED_AT,
      privateJwks: [keys.privateJwk],
    });
    const issued = await issuer.issueCapabilityToken({
      callerAccess: 'service',
      callerServiceId: 'worker-a',
      scopes: ['example.read'],
      targetServiceId: 'example',
    });
    return { issued, service: deployed.service };
  }

  async function openSession(fixture: Awaited<ReturnType<typeof createFixture>>) {
    return abilitySession<{
      badItem(input: { query: string }): Promise<ReadableStream<{ result: string }>>;
      listChunks(input: { query: string }): Promise<ReadableStream<{ result: string }>>;
    }>({
      abilityId: 'example.stream',
      callerServiceId: 'worker-a',
      requestToken: async () => fixture.issued,
      scopes: ['example.read'],
      targetServiceId: 'example',
      transport: cloudflareNativeRpc(fixture.service),
    });
  }

  it('streams vendor-validated items across the RPC boundary', async () => {
    const api = await openSession(await createFixture());

    await expect(drainStream(await api.listChunks({ query: 'go' }))).resolves.toEqual([{ result: 'a' }, { result: 'b' }, { result: 'c' }]);
  });

  it('propagates a vendor rejection mid-stream to the remote consumer', async () => {
    const api = await openSession(await createFixture());
    const reader = (await api.badItem({ query: 'go' })).getReader();

    await expect(reader.read()).resolves.toEqual({ done: false, value: { result: 'ok' } });
    await expect(reader.read()).rejects.toThrow(/Invalid input/u);
  });
});

describe('standard schema abilities', () => {
  it('projects and validates through a non-Zod vendor', async () => {
    const service = searchService(stringField('query'), stringField('result'));

    expect(serviceDiscoveryDocument(service).abilities[0]?.methods.search?.inputSchema).toEqual({
      properties: { query: { type: 'string' } },
      required: ['query'],
      type: 'object',
    });

    const ability = service.abilities[0];
    if (!ability) throw new Error('missing ability');
    const handler = createValidatingAbilityHandler(
      ability,
      new EchoHandler() as EchoHandler & Record<string, unknown>,
      identity,
    ) as unknown as {
      search(input: { query: string }): Promise<{ result: string }>;
    };

    await expect(handler.search({ query: 'hi' })).resolves.toEqual({ result: 'hi' });
    await expect(handler.search({ query: 1 } as never)).rejects.toThrow('Service-Plane ability input for search: query: Invalid input');
  });

  it('mixes vendors down to the individual schema', () => {
    // Each schema is consumed on its own, so input and output of one method may come from
    // different libraries — nothing pins a service, ability, or method to a single vendor.
    const doc = serviceDiscoveryDocument(searchService(z.object({ query: z.string() }), stringField('result')));

    expect(doc.abilities[0]?.methods.search?.inputSchema).toMatchObject({ properties: { query: { type: 'string' } } });
    expect(doc.abilities[0]?.methods.search?.outputSchema).toEqual({
      properties: { result: { type: 'string' } },
      required: ['result'],
      type: 'object',
    });
  });

  it('carries each vendor’s rendering into discovery verbatim', () => {
    // Deliberately not asserting that two libraries produce identical documents — they do not.
    // Zod adds `$schema` and, on the output side, `additionalProperties: false`. What Service
    // Plane guarantees is the requested dialect (below), not a normalized document.
    const zodDoc = serviceDiscoveryDocument(searchService(z.object({ query: z.string() }), z.object({ result: z.string() })));

    expect(zodDoc.abilities[0]?.methods.search?.inputSchema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: { query: { type: 'string' } },
      required: ['query'],
      type: 'object',
    });
  });

  it('asks every converter for the draft-2020-12 target', () => {
    const targets: string[] = [];
    serviceDiscoveryDocument(searchService(stringField('query', targets), stringField('result', targets)));

    expect(targets).toEqual(['draft-2020-12', 'draft-2020-12']);
  });

  it('rejects a schema without Standard JSON Schema support at setup', () => {
    expect(() => searchService(malformedSchema({ validate: (value: unknown) => ({ value }) }), stringField('result'))).toThrow(
      /does not implement Standard JSON Schema .* for example\.search\/search/u,
    );
  });

  it('rejects a schema that cannot validate at setup rather than on the first call', () => {
    expect(() =>
      searchService(malformedSchema({ jsonSchema: { input: jsonSchemaOnly, output: jsonSchemaOnly } }), stringField('result')),
    ).toThrow('Service-Plane ability schema does not implement Standard Schema validation (malformed) for example.search/search');
  });

  it('rejects a value that is not a Standard Schema at all', () => {
    expect(() => searchService({ parse: (value: unknown) => value } as unknown as AbilitySchema, stringField('result'))).toThrow(
      'Service-Plane ability schema is not a Standard Schema (https://standardschema.dev) for example.search/search',
    );
  });

  it('rejects a converter that renders a non-object JSON Schema', () => {
    const booleanSchema = malformedSchema({
      jsonSchema: { input: () => true, output: () => true },
      validate: (value: unknown) => ({ value }),
    });

    expect(() => searchService(booleanSchema, stringField('result'))).toThrow(
      /rendered a non-object JSON Schema for example\.search\/search/u,
    );
  });

  it('rejects duplicate method names that collide after trimming', () => {
    expect(() =>
      defineAbilityService({
        abilities: [
          defineAbility({
            id: 'example.search',
            methods: {
              ' search': abilityMethod({ input: stringField('query'), output: stringField('result'), scopes: ['example.search'] }),
              search: abilityMethod({ input: stringField('query'), output: stringField('result'), scopes: [] }),
            },
            scopes: ['example.search'],
            handler: () => new EchoHandler() as EchoHandler & Record<string, unknown>,
          }),
        ],
        capabilities,
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      }),
    ).toThrow('Service-Plane ability method name is duplicated: example.search/search');
  });

  it('rejects a schema JSON Schema cannot represent at setup', () => {
    expect(() =>
      searchService(
        z.object({ query: z.string() }),
        z.object({ result: z.string() }).transform((value) => value.result),
      ),
    ).toThrow(/cannot be represented as JSON Schema for example\.search\/search/u);
  });

  it('reports issue paths from the schema library', async () => {
    const service = searchService(z.object({ query: z.string() }), z.object({ result: z.string() }));
    const ability = service.abilities[0];
    if (!ability) throw new Error('missing ability');
    const handler = createValidatingAbilityHandler(
      ability,
      new EchoHandler() as EchoHandler & Record<string, unknown>,
      identity,
    ) as unknown as {
      search(input: unknown): Promise<unknown>;
    };

    await expect(handler.search({ query: 7 })).rejects.toMatchObject({
      // Structured issues survive alongside the joined message, so a gateway can build a
      // field-level response without re-parsing text.
      issues: [{ message: expect.stringContaining('Invalid input'), path: ['query'] }],
      message: expect.stringContaining('Service-Plane ability input for search: query: Invalid input'),
      name: 'AbilityValidationError',
      status: 422,
    });
  });

  it('rejects a handler whose return value fails its own output schema', async () => {
    // The unary output guard: a handler that breaks its declared contract is a 500, not a 422,
    // and its unvalidated value never reaches the caller.
    const handler = searchHandler(stringField('query'), z.object({ result: z.number() }));

    await expect(handler.search({ query: 'hi' })).rejects.toMatchObject({
      message: expect.stringContaining('Service-Plane ability output for search: result:'),
      name: 'AbilityValidationError',
      status: 500,
    });
  });

  it('fails closed when a validator returns neither a value nor issues', async () => {
    // Without this the handler would run on `undefined` and the call would succeed, silently
    // skipping validation entirely.
    const handler = searchHandler(
      malformedSchema({ jsonSchema: { input: jsonSchemaOnly, output: jsonSchemaOnly }, validate: () => ({}) }),
      stringField('result'),
    );

    await expect(handler.search({ query: 'hi' })).rejects.toMatchObject({
      message: 'Service-Plane ability input for search: schema returned no validated value',
      name: 'AbilityValidationError',
      status: 422,
    });
  });

  it('classifies a validator that throws instead of returning issues', async () => {
    const handler = searchHandler(
      malformedSchema({
        jsonSchema: { input: jsonSchemaOnly, output: jsonSchemaOnly },
        validate: () => {
          throw new Error('refinement exploded');
        },
      }),
      stringField('result'),
    );

    await expect(handler.search({ query: 'hi' })).rejects.toMatchObject({
      message: 'Service-Plane ability input for search: refinement exploded',
      name: 'AbilityValidationError',
      status: 422,
    });
  });

  it('survives malformed issue data from a third-party validator', async () => {
    const cases: Array<{ issues: unknown; message: string }> = [
      { issues: [{ message: 'bad', path: [null] }], message: 'Service-Plane ability input for search: null: bad' },
      { issues: [{ message: 'bad', path: 'query' }], message: 'Service-Plane ability input for search: bad' },
      { issues: [], message: 'Service-Plane ability input for search: schema reported no issue detail' },
    ];

    for (const { issues, message } of cases) {
      const handler = searchHandler(
        malformedSchema({ jsonSchema: { input: jsonSchemaOnly, output: jsonSchemaOnly }, validate: () => ({ issues }) }),
        stringField('result'),
      );
      await expect(handler.search({ query: 'hi' })).rejects.toMatchObject({ message, name: 'AbilityValidationError', status: 422 });
    }
  });
});

// Type-level: a hand-written Standard Schema satisfies the ability schema contract without any
// validation library, and its inferred types flow into the handler signature.
const _typeProbe: AbilitySchema = { '~standard': {} } as unknown as StandardSchemaV1 & StandardJSONSchemaV1;
void _typeProbe;
