import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { AbilityValidationIssue } from '../shared/errors.js';

/** Treats a validator that returned neither a value nor issues as a failure, never as a pass. */
export function failClosedValidationResult(result: unknown): StandardSchemaV1.Result<unknown> {
  if (result && typeof result === 'object' && ('value' in result || (result as { issues?: unknown }).issues)) {
    return result as StandardSchemaV1.Result<unknown>;
  }
  return { issues: [{ message: 'Standard Schema validator returned neither a value nor issues' }] };
}

/** Flattens Standard Schema issue paths to the property keys callers receive. */
export function normalizeValidationIssues(issues: readonly StandardSchemaV1.Issue[]): AbilityValidationIssue[] {
  return issues.map((issue) => ({
    message: issue.message,
    ...(issue.path ? { path: issue.path.map((segment) => (typeof segment === 'object' ? segment.key : segment)) } : {}),
  }));
}

export function formatValidationIssues(issues: AbilityValidationIssue[]): string {
  return issues.length === 0
    ? 'schema reported no issue detail'
    : issues.map((issue) => `${issue.path?.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`).join('; ');
}
