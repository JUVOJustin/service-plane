import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import type { CapabilityIdentity } from '../shared/types.js';
import { defineCapabilities, RpcTarget } from './capabilities.js';
import {
  abilityMethod,
  createValidatingAbilityHandler,
  defineAbility,
  defineAbilityService,
  serviceDiscoveryDocument,
} from './discovery.js';

describe('ability service discovery', () => {
  const capabilities = defineCapabilities({
    scopes: [{ id: 'example.search' }, { id: 'example.sync.run' }],
    serviceId: 'example',
  });

  const searchAbility = defineAbility({
    access: 'plane',
    exposure: 'published',
    id: 'example.search',
    methods: {
      search: abilityMethod({
        input: z.object({ query: z.string() }),
        mcp: { name: 'example_search' },
        output: z.object({ results: z.array(z.string()) }),
        rest: { method: 'get', path: '/examples/search', summary: 'Search examples' },
        scopes: ['example.search'],
      }),
    },
    scopes: ['example.search'],
    handler: () => new RpcTarget() as RpcTarget & Record<string, unknown>,
    title: 'Example Search',
  });

  it('builds a discovery document from explicit abilities', () => {
    const service = defineAbilityService({
      abilities: [
        searchAbility,
        defineAbility({
          id: 'example.sync',
          methods: {
            runSync: abilityMethod({
              input: z.object({ since: z.string().optional() }),
              output: z.object({ ok: z.literal(true) }),
              scopes: ['example.sync.run'],
            }),
          },
          rpc: { transports: ['http-batch', 'websocket'] },
          scopes: ['example.sync.run'],
          handler: () => new RpcTarget() as RpcTarget & Record<string, unknown>,
        }),
      ],
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });

    expect(serviceDiscoveryDocument(service)).toMatchObject({
      abilities: [
        {
          access: 'plane',
          exposure: 'published',
          id: 'example.search',
          methods: {
            search: {
              inputSchema: { properties: { query: { type: 'string' } }, required: ['query'], type: 'object' },
              mcp: { name: 'example_search' },
              outputSchema: {
                properties: { results: { items: { type: 'string' }, type: 'array' } },
                required: ['results'],
                type: 'object',
              },
              rest: { method: 'get', operationId: 'example.search.search', path: '/examples/search' },
              scopes: ['example.search'],
            },
          },
          rpc: { path: '/rpc/example.search', transports: ['http-batch'] },
          scopes: ['example.search'],
        },
        {
          access: 'plane',
          exposure: 'private',
          id: 'example.sync',
          rpc: { path: '/rpc/example.sync', transports: ['http-batch', 'websocket'] },
        },
      ],
      id: 'example',
    });
  });

  it('publishes MCP resource and prompt projections in discovery', () => {
    const service = defineAbilityService({
      abilities: [
        defineAbility({
          access: 'plane',
          exposure: 'published',
          id: 'example.search',
          methods: {
            item: abilityMethod({
              input: z.object({ itemId: z.string() }),
              mcpResource: { description: 'One item', name: 'item', uri: 'example://items/{itemId}' },
              output: z.object({ id: z.string() }),
              scopes: ['example.search'],
            }),
            readme: abilityMethod({
              input: z.object({}),
              mcpResource: { mimeType: 'text/markdown', name: 'readme', title: 'Readme', uri: ' example://docs/readme ' },
              output: z.string(),
              scopes: ['example.search'],
            }),
            summarize: abilityMethod({
              input: z.object({ topic: z.string() }),
              mcpPrompt: {
                arguments: [{ description: 'What to summarize', name: ' topic ', required: true }],
                description: 'Summarize a topic',
                name: 'example_summarize',
              },
              output: z.string(),
              scopes: ['example.search'],
            }),
          },
          scopes: ['example.search'],
          handler: () => new RpcTarget() as RpcTarget & Record<string, unknown>,
        }),
      ],
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });

    expect(serviceDiscoveryDocument(service)).toMatchObject({
      abilities: [
        {
          id: 'example.search',
          methods: {
            item: { mcpResource: { description: 'One item', name: 'item', uri: 'example://items/{itemId}' } },
            readme: { mcpResource: { mimeType: 'text/markdown', name: 'readme', title: 'Readme', uri: 'example://docs/readme' } },
            summarize: {
              mcpPrompt: {
                arguments: [{ description: 'What to summarize', name: 'topic', required: true }],
                description: 'Summarize a topic',
                name: 'example_summarize',
              },
            },
          },
        },
      ],
    });
  });

  it('rejects invalid MCP resource and prompt metadata', () => {
    const abilityWith = (methods: Parameters<typeof defineAbility>[0]['methods']) => () =>
      defineAbilityService({
        abilities: [
          defineAbility({
            access: 'plane',
            exposure: 'published',
            id: 'example.search',
            methods,
            scopes: ['example.search'],
            handler: () => new RpcTarget() as RpcTarget & Record<string, unknown>,
          }),
        ],
        capabilities,
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      });
    const base = { input: z.object({}), output: z.string(), scopes: ['example.search'] };

    expect(abilityWith({ read: abilityMethod({ ...base, mcpResource: { name: 'item', uri: 'example://items/{item-id}' } }) })).toThrow(
      'invalid template expression',
    );
    expect(abilityWith({ read: abilityMethod({ ...base, mcpResource: { name: 'item', uri: 'example://items/{itemId' } }) })).toThrow(
      'invalid template expression',
    );
    expect(abilityWith({ read: abilityMethod({ ...base, mcpResource: { name: 'item', uri: 'example://items/}itemId{' } }) })).toThrow(
      'invalid template expression',
    );
    expect(abilityWith({ read: abilityMethod({ ...base, mcpResource: { name: 'item', uri: '  ' } }) })).toThrow(
      'MCP resource URI for example.search/read cannot be empty',
    );
    expect(abilityWith({ read: abilityMethod({ ...base, mcpResource: { name: ' ', uri: 'example://items' } }) })).toThrow(
      'MCP resource name for example.search/read cannot be empty',
    );
    expect(abilityWith({ read: abilityMethod({ ...base, mcpPrompt: { name: ' ' } }) })).toThrow(
      'MCP prompt name for example.search/read cannot be empty',
    );
    expect(abilityWith({ read: abilityMethod({ ...base, mcpPrompt: { arguments: [{ name: ' ' }], name: 'example_prompt' } }) })).toThrow(
      'MCP prompt argument name for example.search/read cannot be empty',
    );
  });

  it('rejects duplicate ability ids, unknown scopes, and unscoped abilities', () => {
    expect(() =>
      defineAbilityService({
        abilities: [searchAbility, searchAbility],
        capabilities,
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      }),
    ).toThrow('Duplicate Service-Plane ability: example.search');

    expect(() =>
      defineAbilityService({
        abilities: [
          defineAbility({
            id: 'example.unknown',
            methods: {
              run: abilityMethod({ input: z.object({}), output: z.object({}), scopes: ['example.unknown'] }),
            },
            scopes: ['example.unknown'],
            handler: () => new RpcTarget() as RpcTarget & Record<string, unknown>,
          }),
        ],
        capabilities,
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      }),
    ).toThrow('Service-Plane ability requires unknown scope: example.unknown');

    expect(() =>
      defineAbilityService({
        abilities: [
          defineAbility({
            id: 'example.unscoped',
            methods: { run: abilityMethod({ input: z.object({}), output: z.object({}) }) },
            handler: () => new RpcTarget() as RpcTarget & Record<string, unknown>,
          }),
        ],
        capabilities,
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      }),
    ).toThrow('Service-Plane ability is missing required scopes: example.unscoped');

    expect(() =>
      defineAbilityService({
        abilities: [
          defineAbility({
            id: 'example.unscoped-method',
            methods: { run: abilityMethod({ input: z.object({}), output: z.object({}) }) },
            scopes: ['example.sync.run'],
            handler: () => new RpcTarget() as RpcTarget & Record<string, unknown>,
          }),
        ],
        capabilities,
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      }),
    ).toThrow('Service-Plane ability method is missing required scopes: example.unscoped-method/run');

    expect(() =>
      defineAbilityService({
        abilities: [
          defineAbility({
            id: 'example.scope-mismatch',
            methods: {
              run: abilityMethod({ input: z.object({}), output: z.object({}), scopes: ['example.sync.run'] }),
            },
            scopes: ['example.search'],
            handler: () => new RpcTarget() as RpcTarget & Record<string, unknown>,
          }),
        ],
        capabilities,
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      }),
    ).toThrow('Service-Plane ability method requires scope not declared by ability: example.scope-mismatch/run -> example.sync.run');
  });

  it('defaults abilities to private plane access', () => {
    const service = defineAbilityService({
      abilities: [
        defineAbility({
          id: 'example.sync',
          methods: {
            run: abilityMethod({ input: z.object({}), output: z.object({}), scopes: ['example.sync.run'] }),
          },
          scopes: ['example.sync.run'],
          handler: () => new RpcTarget() as RpcTarget & Record<string, unknown>,
        }),
      ],
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });

    expect(serviceDiscoveryDocument(service).abilities[0]).toMatchObject({ access: 'plane', exposure: 'private' });
  });

  it('rejects abilities without a handler factory', () => {
    expect(() =>
      defineAbilityService({
        abilities: [
          defineAbility({
            handler: undefined as never,
            id: 'example.sync',
            methods: {
              run: abilityMethod({ input: z.object({}), output: z.object({}), scopes: ['example.sync.run'] }),
            },
            scopes: ['example.sync.run'],
          }),
        ],
        capabilities,
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      }),
    ).toThrow('Service-Plane ability requires a handler factory: example.sync');
  });

  it('does not publish private caller-auth key material', () => {
    expect(() =>
      defineAbilityService({
        abilities: [
          defineAbility({
            id: 'example.sync',
            methods: {
              run: abilityMethod({ input: z.object({}), output: z.object({}), scopes: ['example.sync.run'] }),
            },
            scopes: ['example.sync.run'],
            handler: () => new RpcTarget() as RpcTarget & Record<string, unknown>,
          }),
        ],
        callerAuth: {
          jwks: {
            keys: [
              { d: 'private', kid: 'caller' },
              { kid: 'caller-rsa', oth: [{ d: 'private' }] },
            ],
          },
        },
        capabilities,
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      }),
    ).toThrow('Service-Plane caller-auth JWKS must not include private key material');
  });
});

describe('ability handler safety', () => {
  const capabilities = defineCapabilities({
    scopes: [{ id: 'example.search' }],
    serviceId: 'example',
  });

  const identity = (tokenId: string): CapabilityIdentity => ({
    audience: 'example',
    expiresAt: new Date('2100-01-01T00:00:00Z'),
    issuer: 'control-plane',
    scopes: ['example.search'],
    serviceId: 'caller',
    tokenId,
  });

  const searchService = () =>
    defineAbilityService({
      abilities: [
        defineAbility({
          id: 'example.search',
          methods: {
            search: abilityMethod({
              input: z.object({ query: z.string() }),
              output: z.object({ results: z.array(z.string()) }),
              scopes: ['example.search'],
            }),
          },
          scopes: ['example.search'],
          handler: () => new RpcTarget() as RpcTarget & Record<string, unknown>,
        }),
      ],
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });

  it('rejects ability methods with reserved names', () => {
    expect(() =>
      defineAbilityService({
        abilities: [
          defineAbility({
            id: 'example.bad',
            methods: {
              invoke: abilityMethod({
                input: z.object({}),
                output: z.object({}),
                scopes: ['example.search'],
              }),
            },
            scopes: ['example.search'],
            handler: () => new RpcTarget() as RpcTarget & Record<string, unknown>,
          }),
        ],
        capabilities,
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      }),
    ).toThrow('Service-Plane ability method name is reserved: example.bad/invoke');
  });

  it('rejects handler factories that return a shared instance across sessions', () => {
    const ability = searchService().abilities[0];
    if (!ability) throw new Error('missing ability');
    const shared = new RpcTarget() as RpcTarget & Record<string, unknown>;

    expect(createValidatingAbilityHandler(ability, shared, identity('cap_1'))).toBeDefined();
    expect(() => createValidatingAbilityHandler(ability, shared, identity('cap_2'))).toThrow(
      'Service-Plane ability handler factory must return a new instance per call: example.search',
    );
  });
});
