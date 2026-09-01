import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { type AbilityMethodMetadata, createAbilityBuilder } from './ability.js';
import { defineCapabilities } from './capabilities.js';
import { defineAbility, defineAbilityService, implementAbility, serviceDiscoveryDocument } from './discovery.js';

describe('ability service discovery', () => {
  const capabilities = defineCapabilities({
    scopes: [{ id: 'example.search' }, { id: 'example.sync.run' }],
    serviceId: 'example',
  });
  const ability = createAbilityBuilder();

  const searchAbility = defineAbility({
    access: 'plane',
    exposure: 'published',
    id: 'example.search',
    methods: {
      search: ability.method({
        mcp: { name: 'example_search' },
        rest: { method: 'get', path: '/examples/search', summary: 'Search examples' },
        scopes: ['example.search'],
        input: z.object({ query: z.string() }),
        output: z.object({ results: z.array(z.string()) }),
        handler: ({ input }) => ({ results: [input.query] }),
      }),
    },
    scopes: ['example.search'],
    title: 'Example Search',
  });

  it('builds a discovery document from explicit abilities', () => {
    const service = defineAbilityService({
      abilities: [
        searchAbility,
        defineAbility({
          id: 'example.sync',
          methods: {
            runSync: ability.method({
              scopes: ['example.sync.run'],
              input: z.object({ since: z.string().optional() }),
              output: z.object({ ok: z.literal(true) }),
              handler: () => ({ ok: true as const }),
            }),
          },
          rpc: { transports: ['fetch', 'websocket'] },
          scopes: ['example.sync.run'],
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
              rest: { method: 'get', operationId: 'example.example.search.search', path: '/examples/search' },
              scopes: ['example.search'],
            },
          },
          rpc: { path: '/rpc/example.search', transports: ['fetch'] },
          scopes: ['example.search'],
        },
        {
          access: 'plane',
          exposure: 'private',
          id: 'example.sync',
          rpc: { path: '/rpc/example.sync', transports: ['fetch', 'websocket'] },
        },
      ],
      id: 'example',
    });
  });

  it('snapshots and freezes the live declarative service graph', () => {
    const methodScopes = ['example.search'];
    const restTags = ['examples'];
    const rest: { method: 'post'; path: string; tags: string[] } = {
      method: 'post',
      path: '/examples/run',
      tags: restTags,
    };
    const run = ability.method({
      handler: ({ input }) => input,
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      rest,
      scopes: methodScopes,
    });
    const sourceMethods: Record<string, typeof run> = { run };
    const abilityScopes = ['example.search'];
    const transports: Array<'fetch' | 'websocket'> = ['fetch'];
    const contract = defineAbility({
      exposure: 'published',
      id: 'example.immutable',
      methods: sourceMethods,
      rpc: { transports },
      scopes: abilityScopes,
    });

    sourceMethods.extra = run;
    abilityScopes.splice(0);
    transports.push('websocket');
    methodScopes.splice(0);
    rest.path = '/changed';
    restTags.splice(0);

    expect(Object.isFrozen(run)).toBe(true);
    expect(Object.isFrozen(run.metadata)).toBe(true);
    expect(Object.isFrozen(run.metadata.rest)).toBe(true);
    expect(Object.isFrozen(run.metadata.rest?.tags)).toBe(true);
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.methods)).toBe(true);
    expect(Object.isFrozen(contract.rpc)).toBe(true);
    expect(Object.isFrozen(contract.rpc?.transports)).toBe(true);
    expect(Object.isFrozen(contract.scopes)).toBe(true);
    expect(Object.keys(contract.methods)).toEqual(['run']);
    expect(contract.methods.run?.metadata).toMatchObject({
      rest: { path: '/examples/run', tags: ['examples'] },
      scopes: ['example.search'],
    });
    expect(contract.rpc?.transports).toEqual(['fetch']);
    expect(contract.scopes).toEqual(['example.search']);

    const capabilityInput = { scopes: [{ id: 'example.search' }], serviceId: 'example' };
    const callerKeys: Array<JsonWebKey & { kid?: string }> = [{ key_ops: ['verify'], kid: 'caller', kty: 'EC' }];
    const service = defineAbilityService({
      abilities: [contract],
      callerAuth: { jwks: { keys: callerKeys } },
      capabilities: capabilityInput,
      id: 'example',
      title: 'Example',
      version: '1.0.0',
    });
    capabilityInput.scopes.splice(0);
    const sourceCallerKey = callerKeys[0];
    if (!sourceCallerKey) throw new Error('missing source caller key');
    sourceCallerKey.kid = 'changed';
    sourceCallerKey.key_ops?.push('sign');

    const normalizedAbility = service.abilities[0];
    const normalizedMethod = normalizedAbility?.methods.run;
    const serviceCapabilities = service.capabilities;
    const liveKeyOperations = service.callerAuth?.jwks.keys[0]?.key_ops;
    if (!normalizedAbility || !normalizedMethod || !serviceCapabilities || !liveKeyOperations) {
      throw new Error('missing normalized ability');
    }
    expect(Object.isFrozen(service)).toBe(true);
    expect(Object.isFrozen(service.abilities)).toBe(true);
    expect(Object.isFrozen(serviceCapabilities)).toBe(true);
    expect(Object.isFrozen(serviceCapabilities.scopes)).toBe(true);
    expect(Object.isFrozen(serviceCapabilities.scopes[0])).toBe(true);
    expect(Object.isFrozen(service.callerAuth)).toBe(true);
    expect(Object.isFrozen(service.callerAuth?.jwks)).toBe(true);
    expect(Object.isFrozen(service.callerAuth?.jwks.keys)).toBe(true);
    expect(Object.isFrozen(service.callerAuth?.jwks.keys[0])).toBe(true);
    expect(Object.isFrozen(service.callerAuth?.jwks.keys[0]?.key_ops)).toBe(true);
    expect(Object.isFrozen(normalizedAbility)).toBe(true);
    expect(Object.isFrozen(normalizedAbility.methods)).toBe(true);
    expect(Object.isFrozen(normalizedMethod)).toBe(true);
    expect(Object.isFrozen(normalizedMethod.rest)).toBe(true);
    expect(Object.isFrozen(normalizedMethod.rest?.tags)).toBe(true);
    expect(Object.isFrozen(normalizedMethod.inputSchema)).toBe(true);
    expect(Object.isFrozen(normalizedMethod.inputSchema.properties)).toBe(true);
    expect(serviceCapabilities.scopes).toEqual([{ id: 'example.search' }]);
    expect(service.callerAuth?.jwks.keys[0]).toMatchObject({ key_ops: ['verify'], kid: 'caller' });

    expect(() => {
      (service as unknown as { id: string }).id = 'changed-service';
    }).toThrow(TypeError);
    expect(() => {
      (serviceCapabilities.scopes as unknown as unknown[]).splice(0);
    }).toThrow(TypeError);
    expect(() => {
      (normalizedMethod.rest as unknown as { path: string }).path = '/changed';
    }).toThrow(TypeError);
    expect(() => {
      (normalizedMethod.inputSchema as unknown as Record<string, unknown>).type = 'string';
    }).toThrow(TypeError);
    expect(() => {
      (liveKeyOperations as unknown as string[]).push('sign');
    }).toThrow(TypeError);

    const discovery = serviceDiscoveryDocument(service);
    expect(discovery).toMatchObject({
      abilities: [{ id: 'example.immutable', methods: { run: { rest: { path: '/examples/run' } } } }],
      id: 'example',
    });
    const discoveryKey = discovery.callerAuth?.jwks.keys[0];
    const discoveryMethod = discovery.abilities[0]?.methods.run;
    const discoveryRequired = discoveryMethod?.inputSchema.required;
    if (!discoveryKey || !Array.isArray(discoveryRequired)) throw new Error('missing discovery snapshot');
    discoveryKey.kid = 'wire-copy';
    discoveryKey.key_ops?.push('sign');
    discoveryRequired.push('wireOnly');

    expect(service.callerAuth?.jwks.keys[0]).toMatchObject({ key_ops: ['verify'], kid: 'caller' });
    expect(normalizedMethod.inputSchema.required).toEqual(['value']);
    expect(serviceDiscoveryDocument(service)).toMatchObject({
      abilities: [{ methods: { run: { inputSchema: { required: ['value'] } } } }],
      callerAuth: { jwks: { keys: [{ key_ops: ['verify'], kid: 'caller' }] } },
    });
  });

  it('accepts the QUERY method for REST projections and rejects unknown methods', () => {
    const withMethod = (method: string) =>
      defineAbilityService({
        abilities: [
          defineAbility({
            exposure: 'published',
            id: 'example.search',
            methods: {
              search: ability.method({
                rest: { method: method as never, path: '/examples/search' },
                scopes: ['example.search'],
                input: z.object({ query: z.string() }),
                output: z.object({ results: z.array(z.string()) }),
                handler: ({ input }) => ({ results: [input.query] }),
              }),
            },
            scopes: ['example.search'],
          }),
        ],
        capabilities,
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      });

    // Uppercase input normalizes like the other verbs do.
    expect(withMethod('QUERY').abilities[0]?.methods.search?.rest?.method).toBe('query');
    expect(() => withMethod('propfind')).toThrow('Unknown Service-Plane REST method: propfind');
  });

  it('qualifies synthesized REST operation ids by service', () => {
    const operationIdFor = (serviceId: string) => {
      const service = defineAbilityService({
        abilities: [searchAbility],
        capabilities: defineCapabilities({ scopes: [{ id: 'example.search' }], serviceId }),
        id: serviceId,
        title: serviceId,
        version: '0.1.0',
      });
      return serviceDiscoveryDocument(service).abilities[0]?.methods.search?.rest?.operationId;
    };

    expect(operationIdFor('alpha')).toBe('alpha.example.search.search');
    expect(operationIdFor('beta')).toBe('beta.example.search.search');
  });

  it('validates REST path templates and explicit success statuses', () => {
    const withRest = (rest: { method: 'post'; path: string; status?: number }) =>
      defineAbilityService({
        abilities: [
          defineAbility({
            exposure: 'published',
            id: 'example.write',
            methods: {
              write: ability.method({
                rest,
                scopes: ['example.search'],
                input: z.object({ id: z.string() }),
                output: z.object({ ok: z.boolean() }),
                handler: () => ({ ok: true }),
              }),
            },
            scopes: ['example.search'],
          }),
        ],
        capabilities,
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      });

    expect(withRest({ method: 'post', path: '/examples/{id}' }).abilities[0]?.methods.write?.rest?.status).toBeUndefined();
    for (const status of [201, 202, 205]) {
      expect(withRest({ method: 'post', path: '/examples/{id}', status }).abilities[0]?.methods.write?.rest?.status).toBe(status);
    }
    expect(() => withRest({ method: 'post', path: '/examples/{id}/again/{id}' })).toThrow('invalid or duplicate template variable');
    expect(() => withRest({ method: 'post', path: '/examples/{connectionId}' })).toThrow(
      'REST path template variable must name a top-level input field: example.write/write -> connectionId',
    );
    for (const status of [199, 200.5, 300]) {
      expect(() => withRest({ method: 'post', path: '/examples/{id}', status })).toThrow(
        'success status must be an integer from 200 through 299',
      );
    }
  });

  it('publishes MCP resource and prompt projections in discovery', () => {
    const service = defineAbilityService({
      abilities: [
        defineAbility({
          access: 'plane',
          exposure: 'published',
          id: 'example.search',
          methods: {
            item: ability.method({
              mcpResource: { description: 'One item', name: 'item', uri: 'example://items/{itemId}' },
              scopes: ['example.search'],
              input: z.object({ itemId: z.string() }),
              output: z.object({ id: z.string() }),
              handler: ({ input }) => ({ id: input.itemId }),
            }),
            readme: ability.method({
              mcpResource: { mimeType: 'text/markdown', name: 'readme', title: 'Readme', uri: ' example://docs/readme ' },
              scopes: ['example.search'],
              input: z.object({}),
              output: z.string(),
              handler: () => '# Readme',
            }),
            summarize: ability.method({
              mcpPrompt: {
                arguments: [{ description: 'What to summarize', name: ' topic ', required: true }],
                description: 'Summarize a topic',
                name: 'example_summarize',
              },
              scopes: ['example.search'],
              input: z.object({ topic: z.string() }),
              output: z.string(),
              handler: ({ input }) => input.topic,
            }),
          },
          scopes: ['example.search'],
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
    const abilityWith = (metadata: AbilityMethodMetadata) => () =>
      defineAbilityService({
        abilities: [
          defineAbility({
            access: 'plane',
            exposure: 'published',
            id: 'example.search',
            methods: {
              read: ability.method({ ...metadata, input: z.object({}), output: z.string(), handler: () => 'item' }),
            },
            scopes: ['example.search'],
          }),
        ],
        capabilities,
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      });

    expect(abilityWith({ mcpResource: { name: 'item', uri: 'example://items/{item-id}' }, scopes: ['example.search'] })).toThrow(
      'invalid template expression',
    );
    expect(abilityWith({ mcpResource: { name: 'item', uri: 'example://items/{itemId' }, scopes: ['example.search'] })).toThrow(
      'invalid template expression',
    );
    expect(abilityWith({ mcpResource: { name: 'item', uri: 'example://items/}itemId{' }, scopes: ['example.search'] })).toThrow(
      'invalid template expression',
    );
    expect(abilityWith({ mcpResource: { name: 'item', uri: '  ' }, scopes: ['example.search'] })).toThrow(
      'MCP resource URI for example.search/read cannot be empty',
    );
    expect(abilityWith({ mcpResource: { name: ' ', uri: 'example://items' }, scopes: ['example.search'] })).toThrow(
      'MCP resource name for example.search/read cannot be empty',
    );
    expect(abilityWith({ mcpPrompt: { name: ' ' }, scopes: ['example.search'] })).toThrow(
      'MCP prompt name for example.search/read cannot be empty',
    );
    expect(abilityWith({ mcpPrompt: { arguments: [{ name: ' ' }], name: 'example_prompt' }, scopes: ['example.search'] })).toThrow(
      'MCP prompt argument name for example.search/read cannot be empty',
    );
  });

  it('rejects RPC and REST paths that can resolve outside the service origin', () => {
    const defineWithPaths =
      (rpcPath: string, restPath = '/examples/search') =>
      () =>
        defineAbilityService({
          abilities: [
            defineAbility({
              id: 'example.search',
              methods: {
                search: ability.method({
                  rest: { method: 'post', path: restPath },
                  scopes: ['example.search'],
                  input: z.object({}),
                  output: z.object({}),
                  handler: () => ({}),
                }),
              },
              rpc: { path: rpcPath },
              scopes: ['example.search'],
            }),
          ],
          capabilities,
          id: 'example',
          title: 'Example',
          version: '0.1.0',
        });

    expect(defineWithPaths('//other.example/rpc')).toThrow('path must be origin-relative');
    expect(defineWithPaths('/rpc/example.search', '/\\other.example/rest')).toThrow('path must be origin-relative');
  });

  it('normalizes the capability catalog and rejects one owned by another service', () => {
    const service = defineAbilityService({
      abilities: [searchAbility],
      capabilities: { scopes: [{ id: ' example.search ' }], serviceId: ' example ' },
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });

    expect(service.capabilities).toEqual({ scopes: [{ id: 'example.search' }], serviceId: 'example' });
    expect(() =>
      defineAbilityService({
        abilities: [searchAbility],
        capabilities: { scopes: [{ id: 'example.search' }], serviceId: 'other' },
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      }),
    ).toThrow('Service-Plane capability catalog belongs to other, not service example');
  });

  it.each([
    ['/rpc/items', '/rpc/items/admin'],
    ['/rpc/items/admin', '/rpc/items'],
    ['/', '/rpc/items'],
  ])('rejects overlapping ability RPC paths %s and %s', (firstPath, secondPath) => {
    const withPath = (id: string, path: string) =>
      defineAbility({
        id,
        methods: {
          run: ability.method({
            handler: () => ({}),
            input: z.object({}),
            output: z.object({}),
            scopes: ['example.search'],
          }),
        },
        rpc: { path, transports: ['fetch', 'websocket'] },
        scopes: ['example.search'],
      });

    expect(() =>
      defineAbilityService({
        abilities: [withPath('example.first', firstPath), withPath('example.second', secondPath)],
        capabilities,
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      }),
    ).toThrow('Overlapping Service-Plane ability RPC paths');
  });

  it('allows ability RPC paths that merely share a string prefix', () => {
    const service = defineAbilityService({
      abilities: [
        { ...searchAbility, rpc: { path: '/rpc/item', transports: ['fetch'] } },
        { ...searchAbility, id: 'example.search-more', rpc: { path: '/rpc/items', transports: ['fetch'] } },
      ],
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });

    expect(service.abilities.map((entry) => entry.rpc.path)).toEqual(['/rpc/item', '/rpc/items']);
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
              run: ability.method({ scopes: ['example.unknown'], input: z.object({}), output: z.object({}), handler: () => ({}) }),
            },
            scopes: ['example.unknown'],
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
            methods: {
              run: ability.method({ input: z.object({}), output: z.object({}), handler: () => ({}) }),
            },
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
            methods: {
              run: ability.method({ input: z.object({}), output: z.object({}), handler: () => ({}) }),
            },
            scopes: ['example.sync.run'],
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
              run: ability.method({ scopes: ['example.sync.run'], input: z.object({}), output: z.object({}), handler: () => ({}) }),
            },
            scopes: ['example.search'],
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
            run: ability.method({ scopes: ['example.sync.run'], input: z.object({}), output: z.object({}), handler: () => ({}) }),
          },
          scopes: ['example.sync.run'],
        }),
      ],
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });

    expect(serviceDiscoveryDocument(service).abilities[0]).toMatchObject({ access: 'plane', exposure: 'private' });
  });

  it.each(['then', 'toJSON', '__proto__'])('rejects the reserved ability method name %s', (methodName) => {
    const method = ability.method({ scopes: ['example.search'], input: z.object({}), output: z.object({}), handler: () => ({}) });

    expect(() =>
      defineAbilityService({
        abilities: [
          defineAbility({
            id: 'example.bad',
            methods: { [methodName]: method },
            scopes: ['example.search'],
          }),
        ],
        capabilities,
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      }),
    ).toThrow(`Service-Plane ability method name is reserved: example.bad/${methodName}`);
  });

  it('rejects an ordinary __proto__ method literal instead of silently losing its typed method', () => {
    expect(() =>
      defineAbility({
        id: 'example.bad',
        methods: {
          __proto__: ability.method({
            handler: () => ({ ok: true as const }),
            input: z.object({}),
            output: z.object({ ok: z.literal(true) }),
          }),
        },
      }),
    ).toThrow('Service-Plane ability method name is reserved: example.bad/__proto__');
  });

  it('keeps valid own methods on a record with an application-defined prototype', () => {
    const method = ability.method({
      handler: () => ({ ok: true as const }),
      input: z.object({}),
      output: z.object({ ok: z.literal(true) }),
    });
    const methods = Object.assign(Object.create({ applicationMetadata: true }) as Record<string, typeof method>, { get: method });

    expect(defineAbility({ id: 'example.custom-record', methods }).methods.get).toBe(method);
  });

  it('accepts natural JavaScript property names as ability methods', () => {
    const names = ['apply', 'call', 'constructor', 'hasOwnProperty', 'name', 'toString', 'valueOf'];
    const method = ability.method({ scopes: ['example.search'], input: z.object({}), output: z.object({}), handler: () => ({}) });
    const service = defineAbilityService({
      abilities: [
        defineAbility({
          id: 'example.natural-names',
          methods: Object.fromEntries(names.map((name) => [name, method])),
          scopes: ['example.search'],
        }),
      ],
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });

    expect(Object.keys(service.abilities[0]?.methods ?? {})).toEqual(names);
  });

  it('requires an own implementation handler for a constructor method', () => {
    const contract = defineAbility({
      id: 'example.constructor',
      methods: {
        constructor: ability.method({ scopes: ['example.search'], input: z.object({}), output: z.object({}) }),
      },
      scopes: ['example.search'],
    });

    expect(() => implementAbility(contract, {} as never)).toThrow(
      'Service-Plane ability implementation is missing method: example.constructor/constructor',
    );
    expect(() => implementAbility(contract, { constructor: () => ({}) })).not.toThrow();
  });

  it('does not publish private caller-auth key material', () => {
    expect(() =>
      defineAbilityService({
        abilities: [
          defineAbility({
            id: 'example.sync',
            methods: {
              run: ability.method({ scopes: ['example.sync.run'], input: z.object({}), output: z.object({}), handler: () => ({}) }),
            },
            scopes: ['example.sync.run'],
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
