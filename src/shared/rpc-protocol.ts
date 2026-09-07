import { ServicePlaneError } from './errors.js';

/** Wire revision owned by Service Plane, independent of application and engine package versions. */
export const SERVICE_PLANE_RPC_PROTOCOL = 'service-plane-rpc/1';

/** Request and response marker used by the private Fetch and WebSocket codec. */
export const SERVICE_PLANE_RPC_PROTOCOL_HEADER = 'x-service-plane-rpc-protocol';

/** Versioned default route keeps new callers away from legacy, unversioned handlers. */
export const SERVICE_PLANE_RPC_PREFIX = '/rpc/v1';

/** Default public broker prefix for the current wire revision. */
export const SERVICE_PLANE_BROKER_RPC_PATH = `${SERVICE_PLANE_RPC_PREFIX}/broker`;

/** Refuses incompatible peers before their payload can reach authorization or execution. */
export function assertServicePlaneRpcProtocol(protocol: unknown): void {
  if (protocol === SERVICE_PLANE_RPC_PROTOCOL) return;
  throw incompatibleRpcProtocolError();
}

/** One stable error for rolling deployments that mix incompatible RPC wire revisions. */
export function incompatibleRpcProtocolError(): ServicePlaneError {
  return new ServicePlaneError(`Service-Plane RPC requires protocol ${SERVICE_PLANE_RPC_PROTOCOL}`, 426, {
    code: 'incompatible_protocol',
    retryable: false,
  });
}

/** Rejects an incompatible physical Fetch request before middleware reads its body. */
export function rpcProtocolPreflight(request: Request): Response | undefined {
  if (request.headers.get(SERVICE_PLANE_RPC_PROTOCOL_HEADER) === SERVICE_PLANE_RPC_PROTOCOL) return;
  void request.body?.cancel().catch(() => undefined);
  const error = incompatibleRpcProtocolError();
  return Response.json(
    { error: { code: error.code, message: error.message, retryable: error.retryable } },
    {
      status: error.status,
      headers: {
        [SERVICE_PLANE_RPC_PROTOCOL_HEADER]: SERVICE_PLANE_RPC_PROTOCOL,
        'access-control-expose-headers': SERVICE_PLANE_RPC_PROTOCOL_HEADER,
      },
    },
  );
}

/** Keeps browser protocol checks readable after Hono merges configured CORS response headers. */
export function rpcProtocolExposedHeaders(headers: Headers): string | undefined {
  if (!headers.has(SERVICE_PLANE_RPC_PROTOCOL_HEADER)) return;
  const exposed = (headers.get('access-control-expose-headers') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (exposed.some((name) => name.toLowerCase() === SERVICE_PLANE_RPC_PROTOCOL_HEADER)) return;
  return [...exposed, SERVICE_PLANE_RPC_PROTOCOL_HEADER].join(', ');
}
