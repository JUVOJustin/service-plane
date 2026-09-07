import { bench, describe } from 'vitest';
import type {
  DiscoveredServiceAbility,
  ServiceAbilityDiscovery,
  ServiceDiscoveryDocument,
  ServiceEndpoint,
  ServiceRegistry,
  ServiceRegistrySnapshot,
} from '../shared/types.js';
import { handleControlPlaneRestRequest } from './rest.js';

const ROUTES = 1_000;
const endpoint: ServiceEndpoint = {
  fetch: async () => new Response(null, { status: 204 }),
  id: 'rest-benchmark',
  origin: 'https://rest-benchmark.internal',
};
const definitions: ServiceAbilityDiscovery[] = Array.from({ length: ROUTES }, (_, index) => ({
  access: 'plane',
  exposure: 'published',
  id: `resource-${index}`,
  methods: {
    get: {
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      rest: { method: 'get', path: `/resources/item-${index}/{id}` },
      scopes: [],
    },
  },
  rpc: { path: `/rpc/v1/resource-${index}`, transports: ['fetch'] },
  scopes: [],
}));
const document: ServiceDiscoveryDocument = {
  abilities: definitions,
  id: endpoint.id,
  title: 'REST benchmark',
  version: '1.0.0',
};
const abilities: DiscoveredServiceAbility[] = definitions.map((ability) => ({
  ...ability,
  service: endpoint,
  serviceId: endpoint.id,
  serviceTitle: document.title,
  serviceVersion: document.version,
}));
const snapshot: ServiceRegistrySnapshot = {
  abilities,
  discoveredAt: '2026-01-01T00:00:00.000Z',
  services: [document],
};
const registry: ServiceRegistry = {
  abilities: async () => abilities,
  ability: async (serviceId, abilityId) => abilities.find((ability) => ability.serviceId === serviceId && ability.id === abilityId),
  discover: async () => snapshot,
  endpoint: (id) => (id === endpoint.id ? endpoint : undefined),
};
const request = new Request(`https://plane.internal/resources/item-${ROUTES - 1}/benchmark`);
const matched = new Response(null, { status: 204 });
const handle = () =>
  handleControlPlaneRestRequest(request, {
    registry,
    resolveInvocation: async () => matched,
  });

// Build the weakly cached route index before measuring the request hot path.
if ((await handle()).status !== 204) throw new Error('REST benchmark route did not match');

describe('control-plane REST route matching', () => {
  bench(
    `${ROUTES.toLocaleString('en-US')} published routes, warm index`,
    async () => {
      if ((await handle()).status !== 204) throw new Error('REST benchmark route did not match');
    },
    { time: 2_000, warmupTime: 250 },
  );
});
