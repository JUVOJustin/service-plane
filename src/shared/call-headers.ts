import { servicePlaneAuthorization } from './capability-tokens.js';
import { type ConnInfo, SERVICE_PLANE_CONN_INFO_HEADER, serializeConnInfo } from './conn-info.js';
import { SERVICE_PLANE_TIMEOUT_HEADER, serializeTimeoutMs } from './deadline.js';
import { normalizeIdempotencyKey, SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER } from './idempotency.js';
import { SERVICE_PLANE_PROOF_HEADER, SERVICE_PLANE_REQUEST_ID_HEADER } from './types.js';

/** Per-call metadata one hop forwards to the next. */
export type ForwardedCallValues = {
  connInfo?: ConnInfo | undefined;
  idempotencyKey?: string | undefined;
  proof?: string | undefined;
  requestId?: string | undefined;
  timeoutMs?: number | undefined;
  token?: string | undefined;
};

/**
 * Writes the forwarded values as headers, normalized on the way out so a hop never emits a value the
 * next one would reject. Absent or invalid values leave their header unset rather than empty.
 */
export function applyForwardedCallHeaders(headers: Headers, values: ForwardedCallValues): Headers {
  const connInfo = serializeConnInfo(values.connInfo);
  const idempotencyKey = normalizeIdempotencyKey(values.idempotencyKey);
  const timeout = serializeTimeoutMs(values.timeoutMs);
  if (values.token) headers.set('authorization', servicePlaneAuthorization(values.token));
  if (connInfo) headers.set(SERVICE_PLANE_CONN_INFO_HEADER, connInfo);
  if (idempotencyKey) headers.set(SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER, idempotencyKey);
  if (values.proof) headers.set(SERVICE_PLANE_PROOF_HEADER, values.proof);
  if (values.requestId) headers.set(SERVICE_PLANE_REQUEST_ID_HEADER, values.requestId);
  if (timeout) headers.set(SERVICE_PLANE_TIMEOUT_HEADER, timeout);
  return headers;
}
