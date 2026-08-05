export class ServicePlaneError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = 'ServicePlaneError';
  }
}

export class CapabilityAuthError extends ServicePlaneError {
  constructor(message: string, status = 401) {
    super(message, status);
    this.name = 'CapabilityAuthError';
  }
}

export class AbilityValidationError extends ServicePlaneError {
  // The schema library's own issues, kept structured so a gateway can build a field-level
  // response instead of re-parsing the joined message. Empty when the failure did not come
  // from a schema (an unknown method, a malformed argument list).
  readonly issues: ReadonlyArray<AbilityValidationIssue>;

  constructor(message: string, status = 422, issues: ReadonlyArray<AbilityValidationIssue> = []) {
    super(message, status);
    this.name = 'AbilityValidationError';
    this.issues = issues;
  }
}

// Structurally the Standard Schema issue shape, restated so consumers reading `issues` do not
// need the spec package and so a malformed vendor issue cannot widen the type.
export type AbilityValidationIssue = {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey> | undefined;
};
