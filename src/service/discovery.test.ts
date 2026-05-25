import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { defineCapabilities, RpcTarget } from './capabilities.js';
import { abilityMethod, defineAbility, defineAbilityService, serviceDiscoveryDocument } from './discovery.js';

describe('ability service discovery', () => {
  const capabilities = defineCapabilities({
    scopes: [{ id: 'example.search' }, { id: 'example.sync.run' }],
    serviceId: 'example',
  });

  const searchAbility = defineAbility({
    auth: 'user',
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
          auth: 'user',
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
          auth: 'service',
          exposure: 'private',
          id: 'example.sync',
          rpc: { path: '/rpc/example.sync', transports: ['http-batch', 'websocket'] },
        },
      ],
      id: 'example',
    });
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

  it('defaults abilities to private service auth', () => {
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

    expect(serviceDiscoveryDocument(service).abilities[0]).toMatchObject({ auth: 'service', exposure: 'private' });
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
