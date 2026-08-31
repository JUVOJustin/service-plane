import { encodeHibernationRPCEvent } from '@orpc/hibernation';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { AbilityValidationError, type AbilityValidationIssue } from '../shared/errors.js';
import type { AbilitySchema } from './ability.js';

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

function failClosedValidationResult(result: unknown): StandardSchemaV1.Result<unknown> {
  if (result && typeof result === 'object' && ('value' in result || (result as { issues?: unknown }).issues)) {
    return result as StandardSchemaV1.Result<unknown>;
  }
  return { issues: [{ message: 'Standard Schema validator returned neither a value nor issues' }] };
}

function normalizeValidationIssues(issues: readonly StandardSchemaV1.Issue[]): AbilityValidationIssue[] {
  return issues.map((issue) => ({
    message: issue.message,
    ...(issue.path ? { path: issue.path.map((segment) => (typeof segment === 'object' ? segment.key : segment)) } : {}),
  }));
}

function formatValidationIssues(issues: AbilityValidationIssue[]): string {
  return issues.length === 0
    ? 'schema reported no issue detail'
    : issues.map((issue) => `${issue.path?.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`).join('; ');
}
