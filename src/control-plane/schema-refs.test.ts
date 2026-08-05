import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { type AbilitySchema, abilityMethod, defineAbility, defineAbilityService, defineCapabilities, RpcTarget } from '../service/index.js';
import type { DiscoveredServiceAbility, OpenApiObject, ServiceEndpoint, ServiceRegistrySnapshot } from '../shared/types.js';
import { generateMcpDiscovery } from './mcp.js';
import { generateControlPlaneOpenApi } from './openapi.js';

// The shape ArkType and Valibot emit for referenced or recursive types: `$defs` plus a root
// `$ref`, instead of Zod's inlined root. Hand-written so no extra vendor is a dev dependency.
function refRootedSchema(): AbilitySchema {
  return {
    '~standard': {
      jsonSchema: {
        input: () => ({
          $defs: { task: { properties: { name: { type: 'string' } }, required: ['name'], type: 'object' } },
          $ref: '#/$defs/task',
        }),
        output: () => ({
          $defs: { task: { properties: { id: { type: 'string' } }, required: ['id'], type: 'object' } },
          $ref: '#/$defs/task',
        }),
      },
      validate: (value: unknown) => ({ value }),
      vendor: 'ref-rooted',
      version: 1,
    },
  } as AbilitySchema;
}

function plainSchema(): AbilitySchema {
  return {
    '~standard': {
      jsonSchema: {
        input: () => ({ properties: { query: { type: 'string' } }, type: 'object' }),
        output: () => ({ properties: { result: { type: 'string' } }, type: 'object' }),
      },
      validate: (value: unknown) => ({ value }),
      vendor: 'plain',
      version: 1,
    },
  } as AbilitySchema;
}

const capabilities = defineCapabilities({ scopes: [{ id: 'example.search' }], serviceId: 'example' });

function serviceWith(input: AbilitySchema, output: AbilitySchema) {
  return defineAbilityService({
    abilities: [
      defineAbility({
        exposure: 'published',
        id: 'example.search',
        methods: {
          search: abilityMethod({
            input,
            mcp: { name: 'example_search' },
            mcpPrompt: { name: 'example_search_prompt' },
            output,
            rest: { method: 'post', path: '/examples/search', summary: 'Search' },
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
}

const endpoint: ServiceEndpoint = {
  fetch: async () => new Response(null, { status: 404 }),
  id: 'example',
  origin: 'https://example.internal',
};

function streamingServiceWith(output: AbilitySchema) {
  return defineAbilityService({
    abilities: [
      defineAbility({
        exposure: 'published',
        id: 'example.stream',
        methods: {
          watch: abilityMethod({ input: plainSchema(), mcp: { name: 'example_watch' }, output, scopes: ['example.search'], stream: true }),
        },
        rpc: { transports: ['websocket'] },
        scopes: ['example.search'],
        handler: () => new RpcTarget() as RpcTarget & Record<string, unknown>,
      }),
    ],
    capabilities,
    id: 'example',
    title: 'Example',
    version: '0.1.0',
  });
}

function snapshotOf(input: AbilitySchema, output: AbilitySchema): ServiceRegistrySnapshot {
  return snapshotFromAbility(serviceWith(input, output).abilities[0]);
}

function snapshotFromAbility(ability: ReturnType<typeof serviceWith>['abilities'][number] | undefined): ServiceRegistrySnapshot {
  if (!ability) throw new Error('missing ability');
  const discovered: DiscoveredServiceAbility = {
    access: ability.access,
    exposure: ability.exposure,
    id: ability.id,
    methods: Object.fromEntries(
      Object.entries(ability.methods).map(([name, method]) => [
        name,
        {
          inputSchema: method.inputSchema,
          ...(method.mcp ? { mcp: method.mcp } : {}),
          ...(method.mcpPrompt ? { mcpPrompt: method.mcpPrompt } : {}),
          outputSchema: method.outputSchema,
          ...(method.rest ? { rest: method.rest } : {}),
          scopes: method.scopes,
          ...(method.stream ? { stream: true as const } : {}),
        },
      ]),
    ),
    rpc: ability.rpc,
    scopes: ability.scopes,
    service: endpoint,
    serviceId: 'example',
    serviceTitle: 'Example',
    serviceVersion: '0.1.0',
  };
  return { abilities: [discovered], discoveredAt: '2026-08-05T12:00:00.000Z', services: [] };
}

// Walks a document and checks every local `$ref` resolves to an existing location inside the
// nearest enclosing schema resource (a subtree carrying `$id`), per JSON Schema 2020-12. This
// is what a spec-conformant OpenAPI 3.1 consumer does; a dangling pointer fails the test.
function assertLocalRefsResolve(document: OpenApiObject): void {
  const walk = (value: unknown, resource: OpenApiObject): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, resource);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const nextResource = typeof record.$id === 'string' ? (record as OpenApiObject) : resource;
    if (typeof record.$ref === 'string' && record.$ref.startsWith('#')) {
      const pointer = record.$ref === '#' ? [] : record.$ref.slice(2).split('/');
      let target: unknown = nextResource;
      for (const segment of pointer) {
        const key = decodeURIComponent(segment).replaceAll('~1', '/').replaceAll('~0', '~');
        target = Array.isArray(target) ? target[Number(key)] : ((target as Record<string, unknown> | null)?.[key] ?? undefined);
      }
      expect(target, `dangling $ref ${record.$ref}`).toBeDefined();
    }
    for (const entry of Object.values(record)) walk(entry, nextResource);
  };
  walk(document, document);
}

describe('schema resource ids at setup', () => {
  it('assigns $id to schemas with local refs and leaves plain schemas untouched', () => {
    const method = serviceWith(refRootedSchema(), plainSchema()).abilities[0]?.methods.search;

    expect(method?.inputSchema.$id).toBe('urn:service-plane:example/example.search/search/input');
    expect(method?.inputSchema.$ref).toBe('#/$defs/task');
    expect(method?.outputSchema.$id).toBeUndefined();
  });

  it('anchors a recursive Zod schema whose refs point at the document root', () => {
    const recursive = z.object({
      name: z.string(),
      get kids() {
        return z.array(recursive);
      },
    });
    const method = serviceWith(recursive, plainSchema()).abilities[0]?.methods.search;

    expect(method?.inputSchema.$id).toBe('urn:service-plane:example/example.search/search/input');
  });

  it('keeps a vendor-declared $id instead of overriding it', () => {
    const withOwnId = {
      '~standard': {
        jsonSchema: {
          input: () => ({ $id: 'https://vendor.example/task', $ref: '#/$defs/t', $defs: { t: { type: 'object' } } }),
          output: () => ({ type: 'object' }),
        },
        validate: (value: unknown) => ({ value }),
        vendor: 'own-id',
        version: 1,
      },
    } as unknown as AbilitySchema;

    const method = serviceWith(withOwnId, plainSchema()).abilities[0]?.methods.search;
    expect(method?.inputSchema.$id).toBe('https://vendor.example/task');
  });
});

describe('OpenAPI embedding of ref-carrying schemas', () => {
  it('embeds $id-anchored schemas whose local refs all resolve', () => {
    const document = generateControlPlaneOpenApi({ snapshot: snapshotOf(refRootedSchema(), refRootedSchema()) });

    const operation = (document.paths as Record<string, Record<string, OpenApiObject>>)['/examples/search']?.post;
    const requestBody = operation?.requestBody as { content: Record<string, { schema: OpenApiObject }> } | undefined;
    expect(requestBody?.content['application/json']?.schema.$id).toBe('urn:service-plane:example/example.search/search/input');
    assertLocalRefsResolve(document as OpenApiObject);
  });

  it('resolves a recursive Zod schema embedded in the document', () => {
    const recursive = z.object({
      name: z.string(),
      get kids() {
        return z.array(recursive);
      },
    });
    const document = generateControlPlaneOpenApi({ snapshot: snapshotOf(recursive, plainSchema()) });
    assertLocalRefsResolve(document as OpenApiObject);
  });
});

describe('MCP projection of ref-rooted schemas', () => {
  it('inlines the root so tools expose an object-typed input and keep their output schema', () => {
    const discovery = generateMcpDiscovery(snapshotOf(refRootedSchema(), refRootedSchema()));
    const tool = discovery.tools.find((entry) => entry.name === 'example_search');

    expect(tool?.inputSchema.type).toBe('object');
    expect(tool?.inputSchema.properties).toMatchObject({ name: { type: 'string' } });
    // $defs stays so internal refs keep resolving within the tool schema document.
    expect(tool?.inputSchema.$defs).toBeDefined();
    expect(tool?.outputSchema).toMatchObject({ properties: { id: { type: 'string' } }, type: 'object' });
  });

  it('derives prompt arguments through a ref root', () => {
    const discovery = generateMcpDiscovery(snapshotOf(refRootedSchema(), plainSchema()));
    const prompt = discovery.prompts.find((entry) => entry.name === 'example_search_prompt');

    expect(prompt?.arguments).toEqual([{ name: 'name', required: true }]);
  });

  it('embeds an $id-anchored streaming item schema without hoisting, refs intact', () => {
    // The hoist-and-rewrite wrapper must not capture an $id-carrying item: the nested resource
    // would re-anchor the rewritten wrapper-relative refs and they would dangle (Codex review
    // finding on this PR). An anchored item embeds as-is; its $id keeps its refs resolving.
    const discovery = generateMcpDiscovery(snapshotFromAbility(streamingServiceWith(refRootedSchema()).abilities[0]));
    const tool = discovery.tools.find((entry) => entry.name === 'example_watch');
    const outputSchema = tool?.outputSchema as OpenApiObject;
    const item = (outputSchema.properties as { items: { items: OpenApiObject } }).items.items;

    expect(item.$id).toBe('urn:service-plane:example/example.stream/watch/output');
    expect(item.$ref).toBe('#/$defs/task');
    expect(outputSchema.$defs).toBeUndefined();
    assertLocalRefsResolve(outputSchema);
  });

  it('still hoists and rewrites $id-less streaming item schemas from older services', () => {
    // Discovery documents produced before schemas carried $id reach the registry unchanged;
    // their root-relative refs must keep being re-anchored to the wrapper.
    const legacy = snapshotFromAbility(streamingServiceWith(refRootedSchema()).abilities[0]);
    const method = legacy.abilities[0]?.methods.watch;
    if (!method) throw new Error('missing method');
    const { $id, ...withoutId } = method.outputSchema;
    void $id;
    method.outputSchema = withoutId;

    const discovery = generateMcpDiscovery(legacy);
    const outputSchema = discovery.tools.find((entry) => entry.name === 'example_watch')?.outputSchema as OpenApiObject;
    const items = (outputSchema.properties as { items: { items: OpenApiObject } }).items.items;

    expect(items.$ref).toBe('#/$defs/item');
    expect((outputSchema.$defs as { item: OpenApiObject }).item.$ref).toBe('#/$defs/item/$defs/task');
    assertLocalRefsResolve(outputSchema);
  });

  it('still omits outputSchema for genuinely non-object outputs', () => {
    const stringOutput = {
      '~standard': {
        jsonSchema: {
          input: () => ({ properties: { query: { type: 'string' } }, type: 'object' }),
          output: () => ({ type: 'string' }),
        },
        validate: (value: unknown) => ({ value }),
        vendor: 'primitive',
        version: 1,
      },
    } as unknown as AbilitySchema;
    const discovery = generateMcpDiscovery(snapshotOf(plainSchema(), stringOutput));

    expect(discovery.tools.find((entry) => entry.name === 'example_search')?.outputSchema).toBeUndefined();
  });
});
