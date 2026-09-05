/** Supported wire compression algorithms. */
export type ServicePlaneCompressionEncoding = 'deflate' | 'deflate-raw' | 'gzip';

/** Default maximum decoded RPC request body: one mebibyte. */
export const DEFAULT_SERVICE_PLANE_RPC_MAX_REQUEST_BODY_BYTES = 1_048_576;

/** Stable batching policy understood by Service Plane clients and servers. */
export type ServicePlaneBatchOptions =
  | boolean
  | {
      /** Maximum logical calls accepted in one batch. */
      maxSize?: number;
    };

/** Fetch compression policy. Requires CompressionStream and DecompressionStream in the runtime. */
export type ServicePlaneClientCompressionOptions =
  | boolean
  | {
      /** Compresses request bodies above the configured threshold. */
      request?:
        | boolean
        | {
            /** Compression algorithm used for request bodies. */
            encoding?: ServicePlaneCompressionEncoding;
            /** Minimum request size in bytes. */
            threshold?: number;
          };
      /** Negotiates response compression. Service Plane compresses non-batched unary responses only. */
      response?:
        | boolean
        | {
            /** Algorithms accepted from the server, in preference order. */
            encodings?: readonly ServicePlaneCompressionEncoding[];
          };
    };

/** Fetch compression policy. Framed batch responses and event streams remain uncompressed. */
export type ServicePlaneServerCompressionOptions =
  | boolean
  | {
      /** Accepts compressed request bodies. */
      request?: boolean;
      /** Compresses eligible non-batched unary responses; never buffers batches or event streams. */
      response?:
        | boolean
        | {
            /** Algorithms available to negotiate with the caller. */
            encodings?: readonly ServicePlaneCompressionEncoding[];
            /** Minimum response size in bytes. */
            threshold?: number;
          };
    };

/** Framework-neutral wire features available on a Service Plane client transport. */
export type ServicePlaneClientWireOptions = {
  /** Combines concurrent unary calls into one physical Fetch request. */
  batch?: ServicePlaneBatchOptions;
  /** Compresses Fetch requests, including batches, and negotiates non-batched unary response compression. */
  compression?: ServicePlaneClientCompressionOptions;
};

/** Framework-neutral wire features available on a Service Plane server endpoint. */
export type ServicePlaneServerWireOptions = {
  /** Accepts batched Fetch requests. */
  batch?: ServicePlaneBatchOptions;
  /** Accepts compressed Fetch requests and/or compresses non-batched unary responses. */
  compression?: ServicePlaneServerCompressionOptions;
  /** Maximum decoded Fetch body or WebSocket message size. Defaults to one MiB; `false` disables the limit. */
  maxRequestBodyBytes?: false | number;
};
