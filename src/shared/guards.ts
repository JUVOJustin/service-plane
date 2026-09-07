import type { AbilityAccess, AbilityExposure, AbilityTransport, ServiceHttpMethod } from './types.js';

/**
 * Membership tests for the closed unions in `types.ts`. Registry validation, discovery
 * normalization, token issuance, and claim parsing all gate on them; one predicate per union keeps
 * a future widening from needing several synchronized hand-written checks.
 */
export function isAbilityAccess(value: unknown): value is AbilityAccess {
  return value === 'plane' || value === 'service';
}

export function isAbilityExposure(value: unknown): value is AbilityExposure {
  return value === 'private' || value === 'published';
}

export function isAbilityTransport(value: unknown): value is AbilityTransport {
  return value === 'fetch' || value === 'service-binding' || value === 'websocket';
}

export function isServiceHttpMethod(value: unknown): value is ServiceHttpMethod {
  return value === 'delete' || value === 'get' || value === 'patch' || value === 'post' || value === 'put' || value === 'query';
}

/** A plain object and never an array: what every untrusted JSON boundary checks before reading members. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

export function isAsyncIterator(value: unknown): value is AsyncIterator<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { next?: unknown }).next === 'function';
}
