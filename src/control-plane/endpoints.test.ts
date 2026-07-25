import { describe, expect, it } from 'vitest';
import type { FetchLike, ServiceAbilityNativeRpcBinding } from '../shared/types.js';
import { cloudflareServiceBinding } from './endpoints.js';

// A Workers service-binding stub answers any property access with a callable RPC proxy, so the
// endpoint must not infer native ability RPC support from the presence of `connectAbility`.
function serviceBindingStub(): FetchLike & Partial<ServiceAbilityNativeRpcBinding> {
  return new Proxy(
    { fetch: async () => new Response(null, { status: 404 }) },
    {
      get(target, property, receiver) {
        if (property in target) return Reflect.get(target, property, receiver);
        return () => Promise.reject(new Error(`no such RPC method: ${String(property)}`));
      },
    },
  ) as FetchLike & Partial<ServiceAbilityNativeRpcBinding>;
}

describe('cloudflareServiceBinding', () => {
  it('does not infer native ability RPC from a service-binding stub', () => {
    const binding = serviceBindingStub();
    expect(typeof binding.connectAbility).toBe('function');
    expect(cloudflareServiceBinding({ binding, id: 'hub' }).abilityRpc).toBeUndefined();
  });

  it('uses the native ability RPC binding when it is passed explicitly', () => {
    const abilityRpc = { connectAbility: () => ({}) };
    expect(cloudflareServiceBinding({ abilityRpc, binding: serviceBindingStub(), id: 'hub' }).abilityRpc).toBe(abilityRpc);
  });
});
