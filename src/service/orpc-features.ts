import { ORPCError, RPCSerializer } from '@orpc/client';
import type { FetchLinkTransportPlugin } from '@orpc/client/fetch';
import { BatchLinkPlugin, RequestCompressionLinkPlugin, ResponseCompressionLinkPlugin } from '@orpc/client/plugins';
import { HibernationHandlerPlugin } from '@orpc/hibernation';
import {
  BatchHandlerPlugin,
  PrototypePollutionProtectionHandlerPlugin,
  RequestCompressionHandlerPlugin,
  RequestHeadersHandlerPlugin,
  RequestLimitHandlerPlugin,
  ResponseCompressionHandlerPlugin,
} from '@orpc/server/plugins';
import type { StandardHandlerPlugin } from '@orpc/server/standard';
import { CapabilityAuthError } from '../shared/errors.js';
import {
  assertServicePlaneRpcProtocol,
  incompatibleRpcProtocolError,
  SERVICE_PLANE_RPC_PROTOCOL,
  SERVICE_PLANE_RPC_PROTOCOL_HEADER,
} from '../shared/rpc-protocol.js';
import {
  DEFAULT_SERVICE_PLANE_RPC_MAX_REQUEST_BODY_BYTES,
  type ServicePlaneClientCompressionOptions,
  type ServicePlaneClientWireOptions,
  type ServicePlaneCompressionEncoding,
  type ServicePlaneServerCompressionOptions,
  type ServicePlaneServerWireOptions,
} from './wire-options.js';

const SUPPORTED_COMPRESSION_ENCODINGS = ['gzip', 'deflate', 'deflate-raw'] as const satisfies readonly ServicePlaneCompressionEncoding[];

/** Compiles stable client feature options into private engine plugins. */
export function createRpcClientPlugins(options: ServicePlaneClientWireOptions): FetchLinkTransportPlugin<object>[] {
  const plugins: FetchLinkTransportPlugin<object>[] = [];
  if (options.batch) {
    const batch = typeof options.batch === 'boolean' ? {} : options.batch;
    plugins.push(
      new BatchLinkPlugin({
        groups: [{ condition: true, context: {} }],
        ...(batch.maxSize === undefined ? {} : { maxSize: validateBatchSize(batch.maxSize) }),
      }),
    );
  }

  const compression = normalizeClientCompression(options.compression);
  if (compression.request) {
    const request =
      typeof compression.request === 'boolean'
        ? {}
        : {
            ...(compression.request.encoding === undefined ? {} : { encoding: validateCompressionEncoding(compression.request.encoding) }),
            ...(compression.request.threshold === undefined
              ? {}
              : { threshold: validateCompressionThreshold(compression.request.threshold) }),
          };
    plugins.push(new RequestCompressionLinkPlugin(request));
  }
  if (compression.response) {
    const response =
      typeof compression.response === 'boolean'
        ? {}
        : {
            ...(compression.response.encodings === undefined
              ? {}
              : { encodings: validateCompressionEncodings(compression.response.encodings) }),
          };
    plugins.push(new ResponseCompressionLinkPlugin(response));
  }
  plugins.push({
    name: 'service-plane-protocol',
    initFetchLinkTransportOptions: (transport) => ({
      ...transport,
      fetchInterceptors: [
        ...(transport.fetchInterceptors ?? []),
        async ({ next }) => {
          const response = await next();
          try {
            assertRpcResponseProtocol(response.status, response.headers.get(SERVICE_PLANE_RPC_PROTOCOL_HEADER));
          } catch (error) {
            // Never decode or retain a potentially infinite body from an incompatible peer.
            void response.body?.cancel().catch(() => undefined);
            throw error;
          }
          return response;
        },
      ],
    }),
    init: (link) => ({
      ...link,
      // After batching: the physical request must carry the marker even if a batch shares no
      // application headers. WebSocket links run this same guard for each logical request.
      transportInterceptors: [
        ...(link.transportInterceptors ?? []),
        async (call) => {
          const response = await call.next({
            ...call,
            request: {
              ...call.request,
              headers: { ...call.request.headers, [SERVICE_PLANE_RPC_PROTOCOL_HEADER]: SERVICE_PLANE_RPC_PROTOCOL },
            },
          });
          assertRpcResponseProtocol(response.status, response.headers[SERVICE_PLANE_RPC_PROTOCOL_HEADER]);
          return response;
        },
      ],
    }),
  });
  return plugins;
}

/** Gateway errors remain meaningful even when a proxy did not preserve our response marker. */
function assertRpcResponseProtocol(status: number, protocol: unknown): void {
  if (status === 426 && protocol === SERVICE_PLANE_RPC_PROTOCOL) throw incompatibleRpcProtocolError();
  if (status < 400) assertServicePlaneRpcProtocol(protocol);
}

/** Compiles stable server feature options into private engine plugins. */
export function createRpcHandlerPlugins<TContext extends object = Record<PropertyKey, unknown>>(
  options: ServicePlaneServerWireOptions,
  hibernation: boolean,
): StandardHandlerPlugin<TContext>[] {
  // These guards apply before decoded values reach schemas or application code. oRPC orders the
  // byte limit around complete batches and after request decompression.
  const plugins: StandardHandlerPlugin<TContext>[] = [
    new PrototypePollutionProtectionHandlerPlugin(),
    // A batch is split before handler interceptors run, so this exposes the headers belonging to
    // the individual logical call rather than only the outer Fetch request.
    new RequestHeadersHandlerPlugin(),
  ];
  if (options.maxRequestBodyBytes !== false) {
    plugins.push(
      new RequestLimitHandlerPlugin({
        maxBodySize: validateRequestBodySize(options.maxRequestBodyBytes ?? DEFAULT_SERVICE_PLANE_RPC_MAX_REQUEST_BODY_BYTES),
      }),
    );
  }
  if (options.batch) {
    const batch = typeof options.batch === 'boolean' ? {} : options.batch;
    plugins.push(new BatchHandlerPlugin(batch.maxSize === undefined ? {} : { maxSize: validateBatchSize(batch.maxSize) }));
  }

  const compression = normalizeServerCompression(options.compression);
  if (compression.request) plugins.push(new RequestCompressionHandlerPlugin());
  if (compression.response) {
    const response =
      typeof compression.response === 'boolean'
        ? {}
        : {
            ...(compression.response.encodings === undefined
              ? {}
              : { encodings: validateCompressionEncodings(compression.response.encodings) }),
            ...(compression.response.threshold === undefined
              ? {}
              : { threshold: validateCompressionThreshold(compression.response.threshold) }),
          };
    plugins.push(new ResponseCompressionHandlerPlugin(response));
  }
  if (hibernation) plugins.push(new HibernationHandlerPlugin());
  const serializer = new RPCSerializer();
  plugins.push({
    name: 'service-plane-protocol',
    init: (handler) => ({
      ...handler,
      // Before routing and batch decoding, including frames forwarded manually by Durable Objects.
      routingInterceptors: [
        async ({ request, next }) => {
          if (request.headers[SERVICE_PLANE_RPC_PROTOCOL_HEADER] !== SERVICE_PLANE_RPC_PROTOCOL) {
            const error = incompatibleRpcProtocolError();
            return {
              matched: true,
              response: {
                status: error.status,
                headers: {
                  [SERVICE_PLANE_RPC_PROTOCOL_HEADER]: SERVICE_PLANE_RPC_PROTOCOL,
                  'access-control-expose-headers': SERVICE_PLANE_RPC_PROTOCOL_HEADER,
                },
                body: serializer.serialize(
                  new ORPCError('UPGRADE_REQUIRED', {
                    message: error.message,
                    data: { servicePlane: { code: error.code, message: error.message, retryable: error.retryable, status: error.status } },
                  }).toJSON(),
                ),
              },
            };
          }
          const result = await next();
          if (result.matched) {
            const exposed = result.response.headers['access-control-expose-headers'];
            result.response.headers[SERVICE_PLANE_RPC_PROTOCOL_HEADER] = SERVICE_PLANE_RPC_PROTOCOL;
            result.response.headers['access-control-expose-headers'] = [
              ...(Array.isArray(exposed) ? exposed : exposed ? [exposed] : []),
              SERVICE_PLANE_RPC_PROTOCOL_HEADER,
            ].join(', ');
          }
          return result;
        },
        ...(handler.routingInterceptors ?? []),
      ],
    }),
  });
  return plugins;
}

function normalizeClientCompression(
  option: ServicePlaneClientCompressionOptions | undefined,
): Exclude<ServicePlaneClientCompressionOptions, boolean> {
  if (!option) return {};
  return option === true ? { request: true, response: true } : option;
}

function normalizeServerCompression(
  option: ServicePlaneServerCompressionOptions | undefined,
): Exclude<ServicePlaneServerCompressionOptions, boolean> {
  if (!option) return {};
  return option === true ? { request: true, response: true } : option;
}

function validateBatchSize(value: number): number {
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new CapabilityAuthError('Service-Plane batch maxSize must be a positive integer', 500);
}

function validateRequestBodySize(value: number): number {
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new CapabilityAuthError('Service-Plane maxRequestBodyBytes must be a positive integer or false', 500);
}

function validateCompressionThreshold(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw new CapabilityAuthError('Service-Plane compression threshold must be a non-negative safe integer', 500);
}

function validateCompressionEncoding(value: unknown): ServicePlaneCompressionEncoding {
  if ((SUPPORTED_COMPRESSION_ENCODINGS as readonly unknown[]).includes(value)) {
    return value as ServicePlaneCompressionEncoding;
  }
  throw new CapabilityAuthError(`Service-Plane compression encoding must be one of: ${SUPPORTED_COMPRESSION_ENCODINGS.join(', ')}`, 500);
}

function validateCompressionEncodings(value: unknown): ServicePlaneCompressionEncoding[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CapabilityAuthError('Service-Plane compression encodings must be a non-empty array', 500);
  }
  return [...new Set(value.map(validateCompressionEncoding))];
}
