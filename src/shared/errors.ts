/**
 * What kind of failure this is, independent of the HTTP-style status. Cap'n Web reconstructs a
 * received error as a plain `Error` — its class table holds only built-ins and the sent `name` is
 * used to pick that class, not restored onto the result — so the class a service threw is gone by
 * the time a caller catches it. Own enumerable properties do survive, which is why the taxonomy
 * lives in `code`, `status`, and `retryable` rather than in the constructor name. Read them with
 * {@link servicePlaneErrorInfo} instead of `instanceof`.
 */
export type ServicePlaneErrorCode =
  /** Input or output did not satisfy the method's schema. */
  | 'ability_validation'
  /** Token, scope, ingress, or proof-of-possession check refused the call. */
  | 'capability_auth'
  /** The ability handler failed deliberately and chose what the caller sees. */
  | 'handler'
  /** Anything else, including a handler failure the service did not shape for callers. */
  | 'internal'
  /** The caller's deadline elapsed. */
  | 'timeout';

export type ServicePlaneErrorOptions = {
  /**
   * The taxonomy entry this failure belongs to; defaults to `internal`.
   */
  code?: ServicePlaneErrorCode;
  /**
   * Whether the *same* call may succeed if made again. Defaults from the status. This says the
   * failure is transient, not that retrying is safe: for a non-idempotent method a retry can still
   * double an effect, which is what a method's `idempotent` marker exists to settle.
   */
  retryable?: boolean;
};

// Only statuses that describe a condition expected to pass on its own. A 500 is deliberately not
// among them: a handler that broke once will usually break again, and calling it retryable would
// invite a retry storm against a service that is already failing.
function defaultRetryable(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

export class ServicePlaneError extends Error {
  /** @see ServicePlaneErrorCode */
  readonly code: ServicePlaneErrorCode;
  /** @see ServicePlaneErrorOptions.retryable */
  readonly retryable: boolean;
  /**
   * HTTP-style classification of the failure, not the HTTP status of the response that carried it:
   * an RPC-level failure travels inside a 200 batch. The number is for gateways mapping the failure
   * onto their own responses, and for the shells where they answer HTTP directly.
   */
  readonly status: number;

  constructor(message: string, status = 500, options: ServicePlaneErrorOptions = {}) {
    super(message);
    this.name = 'ServicePlaneError';
    this.status = status;
    this.code = options.code ?? 'internal';
    this.retryable = options.retryable ?? defaultRetryable(status);
  }
}

export class CapabilityAuthError extends ServicePlaneError {
  constructor(message: string, status = 401) {
    super(message, status, { code: 'capability_auth' });
    this.name = 'CapabilityAuthError';
  }
}

/**
 * The call ran out of the budget its caller gave it. Thrown on whichever hop notices first: the
 * caller when its own wait elapses, the broker when no budget is left to forward, and the service
 * when a handler outlives the deadline it was handed.
 */
export class ServicePlaneTimeoutError extends ServicePlaneError {
  constructor(message: string, status = 504) {
    super(message, status, { code: 'timeout' });
    this.name = 'ServicePlaneTimeoutError';
  }
}

export type AbilityHandlerErrorOptions = ServicePlaneErrorOptions & {
  /**
   * An application-owned discriminator such as `quota_exhausted`, carried to the caller alongside
   * `code: 'handler'`. Separate from `code` so the library's own taxonomy stays a closed set while
   * services can still say which of their failures this was.
   */
  reason?: string;
  status?: number;
};

/**
 * Thrown by an ability handler to say exactly what the caller should see. Everything else a handler
 * throws is replaced with an opaque internal error before it leaves the service, because an
 * arbitrary throw — a database driver error, a `TypeError` — was not written for a caller and can
 * carry connection strings, internal hostnames, or row data. Use this to opt a message in.
 */
export class AbilityHandlerError extends ServicePlaneError {
  /** @see AbilityHandlerErrorOptions.reason */
  readonly reason?: string;

  constructor(message: string, options: AbilityHandlerErrorOptions = {}) {
    super(message, options.status ?? 500, {
      code: 'handler',
      ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
    });
    this.name = 'AbilityHandlerError';
    if (options.reason !== undefined) this.reason = options.reason;
  }
}

export class AbilityValidationError extends ServicePlaneError {
  // The schema library's own issues, kept structured so a gateway can build a field-level
  // response instead of re-parsing the joined message. Empty when the failure did not come
  // from a schema (an unknown method, a malformed argument list).
  readonly issues: ReadonlyArray<AbilityValidationIssue>;

  constructor(message: string, status = 422, issues: ReadonlyArray<AbilityValidationIssue> = []) {
    super(message, status, { code: 'ability_validation' });
    this.name = 'AbilityValidationError';
    this.issues = issues;
  }
}

/**
 * Structurally the Standard Schema issue shape, restated so consumers reading `issues` do not
 * need the spec package and so a malformed vendor issue cannot widen the type.
 */
export type AbilityValidationIssue = {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey> | undefined;
};

/**
 * The taxonomy read off a caught value by {@link servicePlaneErrorInfo} — the shape to branch on,
 * since the error class itself does not survive an RPC hop.
 */
export type ServicePlaneErrorInfo = {
  /** @see ServicePlaneErrorCode */
  code: ServicePlaneErrorCode;
  /**
   * The error message, empty when the peer sent none.
   */
  message: string;
  /**
   * The application-owned discriminator a handler attached via {@link AbilityHandlerError}.
   */
  reason?: string;
  /**
   * Whether the same call may succeed if made again. Transience only — retrying a non-idempotent
   * method can still double an effect.
   */
  retryable: boolean;
  /** @see ServicePlaneError.status */
  status: number;
};

// A Record keyed by the union is the one shape the compiler checks in both directions: a code added
// to the union without a row here is a compile error, and an extra row is too. A bare Set literal
// would drift silently and make servicePlaneErrorInfo blind to the new code.
const SERVICE_PLANE_ERROR_CODE_ROWS: Record<ServicePlaneErrorCode, true> = {
  ability_validation: true,
  capability_auth: true,
  handler: true,
  internal: true,
  timeout: true,
};
const SERVICE_PLANE_ERROR_CODES: ReadonlySet<string> = new Set(Object.keys(SERVICE_PLANE_ERROR_CODE_ROWS));

/**
 * Reads the Service Plane taxonomy off a caught value, whether it is still a real
 * {@link ServicePlaneError} or the plain `Error` a peer's was rebuilt as. Returns undefined for
 * anything that does not carry the taxonomy, so an unrelated failure is never mistaken for one.
 *
 * Every field is re-checked rather than trusted: these values arrive from a peer, and a hostile or
 * buggy one must not be able to make a caller treat a refusal as retryable.
 */
export function servicePlaneErrorInfo(error: unknown): ServicePlaneErrorInfo | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message, reason, retryable, status } = error as Record<string, unknown>;
  if (typeof code !== 'string' || !SERVICE_PLANE_ERROR_CODES.has(code)) return undefined;
  if (typeof status !== 'number' || !Number.isInteger(status) || typeof retryable !== 'boolean') return undefined;
  return {
    code: code as ServicePlaneErrorCode,
    message: typeof message === 'string' ? message : '',
    ...(typeof reason === 'string' ? { reason } : {}),
    retryable,
    status,
  };
}

// Held beside the error rather than on it. Cap'n Web serializes `cause` unconditionally — it checks
// `"cause" in e`, so even a non-enumerable one crosses — and the whole point of replacing a handler
// failure is that its original must not reach the caller. A WeakMap keeps it available in-process
// for logging and debugging and nowhere else.
const handlerFailureCauses = new WeakMap<object, unknown>();

/**
 * Records what a handler actually threw before its opaque replacement went to the caller.
 */
export function rememberHandlerFailureCause(error: object, cause: unknown): void {
  handlerFailureCauses.set(error, cause);
}

/**
 * The original failure behind an opaque handler error, for in-process logging. Always undefined on
 * a caller that received the error over RPC — that is the point of the replacement.
 */
export function handlerFailureCause(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? handlerFailureCauses.get(error) : undefined;
}
