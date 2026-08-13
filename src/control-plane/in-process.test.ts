import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  abilityMethod,
  defineAbility,
  defineCapabilities,
  disposeAbilitySession,
  RpcTarget,
  requireScopes,
  ServicePlaneService,
} from '../service/index.js';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateCapabilitySigningSecret, privateJwkFromCapabilitySigningSecret } from './signing-keys.js';

const SCOPE = 'example.identity.read';

type IdentityResult = {
  brokerServiceId: string | null;
  callerAccess: 'plane' | 'service';
  serviceId: string;
  subjectId: string | null;
  subjectOrgId: string | null;
};

class IdentityApi extends RpcTarget {
  async inspect(_input: Record<string, never>): Promise<IdentityResult> {
    const identity = requireScopes(this, SCOPE);
    return {
      brokerServiceId: identity.brokerServiceId ?? null,
      callerAccess: identity.callerAccess,
      serviceId: identity.serviceId,
      subjectId: identity.subject?.id ?? null,
      subjectOrgId: identity.subject?.orgId ?? null,
    };
  }
}

describe('control-plane in-process ability sessions', () => {
  it.each([
    { expectedBrokerServiceId: null, ingress: false },
    { expectedBrokerServiceId: 'control-plane', ingress: true },
  ])('delegates a normalized user subject when ingress is $ingress', async ({ expectedBrokerServiceId, ingress }) => {
    const plane = await identityPlane(ingress);
    const api = await plane.abilitySession<IdentityApi>(
      {
        abilityId: 'example.identity',
        caller: { id: ' user-7 ', kind: 'user', orgId: ' org-42 ' },
        scopes: [SCOPE],
        targetServiceId: 'example',
      },
      {},
    );

    try {
      await expect(api.inspect({})).resolves.toEqual({
        brokerServiceId: expectedBrokerServiceId,
        callerAccess: 'plane',
        serviceId: 'control-plane',
        subjectId: 'user-7',
        subjectOrgId: 'org-42',
      });
    } finally {
      await disposeAbilitySession(api);
    }
  });

  it('preserves service callers without creating a delegated subject', async () => {
    const plane = await identityPlane(false);
    const api = await plane.abilitySession<IdentityApi>(
      {
        abilityId: 'example.identity',
        caller: { id: 'worker-a', kind: 'service' },
        scopes: [SCOPE],
        targetServiceId: 'example',
      },
      {},
    );

    try {
      await expect(api.inspect({})).resolves.toEqual({
        brokerServiceId: null,
        callerAccess: 'service',
        serviceId: 'worker-a',
        subjectId: null,
        subjectOrgId: null,
      });
    } finally {
      await disposeAbilitySession(api);
    }
  });

  it('opens a plane-owned session without inventing a delegated subject', async () => {
    const plane = await identityPlane(false);
    const api = await plane.abilitySession<IdentityApi>(
      {
        abilityId: 'example.identity',
        scopes: [SCOPE],
        targetServiceId: 'example',
      },
      {},
    );

    try {
      await expect(api.inspect({})).resolves.toEqual({
        brokerServiceId: null,
        callerAccess: 'plane',
        serviceId: 'control-plane',
        subjectId: null,
        subjectOrgId: null,
      });
    } finally {
      await disposeAbilitySession(api);
    }
  });

  it('keeps delegated subjects off the caller-facing native token surface', async () => {
    const plane = await identityPlane(false);

    await expect(
      plane.issueCapabilityTokenForCaller(
        'worker-a',
        {
          scopes: [SCOPE],
          subject: { id: 'user-7' },
          targetServiceId: 'example',
        },
        {},
      ),
    ).rejects.toThrow('capability token subject cannot be asserted by callers');
  });
});

async function identityPlane(ingress: boolean): Promise<ServicePlaneControlPlane> {
  const keyId = 'test-key';
  const secret = await generateCapabilitySigningSecret();
  const privateJwk = privateJwkFromCapabilitySigningSecret(secret, keyId);
  const capabilities = defineCapabilities({
    scopes: [{ id: SCOPE }],
    serviceId: 'example',
  });
  const ability = defineAbility({
    access: 'plane',
    id: 'example.identity',
    methods: {
      inspect: abilityMethod({
        input: z.object({}),
        output: z.object({
          brokerServiceId: z.string().nullable(),
          callerAccess: z.enum(['plane', 'service']),
          serviceId: z.string(),
          subjectId: z.string().nullable(),
          subjectOrgId: z.string().nullable(),
        }),
        scopes: [SCOPE],
      }),
    },
    scopes: [SCOPE],
    handler: () => new IdentityApi() as IdentityApi & Record<string, unknown>,
  });
  const service = new ServicePlaneService({
    abilities: [ability],
    auth: {
      issuer: 'control-plane',
      jwks: { keys: [publicJwkFromPrivateJwk(privateJwk, keyId)] },
    },
    capabilities,
    id: 'example',
    ...(ingress ? { ingress: {} } : {}),
    title: 'Example',
    version: '0.1.0',
  });
  const binding = { fetch: async (request: Request) => service.fetch(request) };

  return new ServicePlaneControlPlane({
    services: () => [
      cloudflareServiceBinding({
        binding,
        grants: [
          { caller: 'control-plane', scopes: [SCOPE] },
          { caller: 'worker-a', scopes: [SCOPE] },
        ],
        id: 'example',
      }),
    ],
    signingKeys: () => [{ kid: keyId, secret }],
  });
}
