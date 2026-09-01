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

/** Compression policy for an outgoing Service Plane client connection. */
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
      /** Advertises and decodes response compression. */
      response?:
        | boolean
        | {
            /** Algorithms accepted from the server, in preference order. */
            encodings?: readonly ServicePlaneCompressionEncoding[];
          };
    };

/** Compression policy for an incoming Service Plane endpoint. */
export type ServicePlaneServerCompressionOptions =
  | boolean
  | {
      /** Accepts compressed request bodies. */
      request?: boolean;
      /** Compresses eligible responses. */
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
  /** Compresses Fetch request and response bodies. */
  compression?: ServicePlaneClientCompressionOptions;
};

/** Framework-neutral wire features available on a Service Plane server endpoint. */
export type ServicePlaneServerWireOptions = {
  /** Accepts batched Fetch requests. */
  batch?: ServicePlaneBatchOptions;
  /** Accepts compressed requests and/or compresses responses. */
  compression?: ServicePlaneServerCompressionOptions;
  /** Maximum decoded Fetch body or WebSocket message size. Defaults to one MiB; `false` disables the limit. */
  maxRequestBodyBytes?: false | number;
};
