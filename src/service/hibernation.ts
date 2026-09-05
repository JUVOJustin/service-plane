import { encodeHibernationRPCEvent } from '@orpc/hibernation';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { AbilityValidationError } from '../shared/errors.js';
import type { AbilitySchema } from './ability.js';
import { failClosedValidationResult, formatValidationIssues, normalizeValidationIssues } from './schema-validation.js';

/** Options for an event emitted after a Durable Object hibernation cycle. */
export type AbilityHibernationEventOptions = {
  /** Whether the event yields a value, fails the stream, or closes it. */
  event?: 'close' | 'error' | 'message';
};

/** Validates and encodes one later yield for a hibernating ability stream. */
export function encodeAbilityHibernationEvent<TOutput extends AbilitySchema>(
  output: TOutput,
  id: string,
  payload: StandardSchemaV1.InferInput<TOutput>,
  options?: AbilityHibernationEventOptions & { event?: 'message' },
): Promise<string | Uint8Array<ArrayBuffer>>;
/** Encodes a protocol error or close event for an existing hibernating ability stream. */
export function encodeAbilityHibernationEvent<TOutput extends AbilitySchema>(
  output: TOutput,
  id: string,
  payload: unknown,
  options: AbilityHibernationEventOptions & { event: 'close' | 'error' },
): Promise<string | Uint8Array<ArrayBuffer>>;
export async function encodeAbilityHibernationEvent<TOutput extends AbilitySchema>(
  output: TOutput,
  id: string,
  payload: unknown,
  options: AbilityHibernationEventOptions = {},
): Promise<string | Uint8Array<ArrayBuffer>> {
  let encodedPayload = payload;
  if (options.event === undefined || options.event === 'message') {
    let result: StandardSchemaV1.Result<StandardSchemaV1.InferOutput<TOutput>>;
    try {
      result = failClosedValidationResult(await output['~standard'].validate(payload)) as StandardSchemaV1.Result<
        StandardSchemaV1.InferOutput<TOutput>
      >;
    } catch {
      throw new AbilityValidationError('Service-Plane hibernation event output validation failed', 500);
    }
    if (result.issues) {
      const issues = normalizeValidationIssues(result.issues);
      throw new AbilityValidationError(
        `Service-Plane hibernation event output failed validation: ${formatValidationIssues(issues)}`,
        500,
        issues,
      );
    }
    encodedPayload = result.value;
  }
  return encodeHibernationRPCEvent(id, encodedPayload, options);
}
