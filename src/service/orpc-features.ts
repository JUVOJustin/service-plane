import { BatchLinkPlugin, RequestCompressionLinkPlugin, ResponseCompressionLinkPlugin } from '@orpc/client/plugins';
import type { StandardLinkPlugin } from '@orpc/client/standard';
import { HibernationHandlerPlugin } from '@orpc/hibernation';
import { BatchHandlerPlugin, RequestCompressionHandlerPlugin, ResponseCompressionHandlerPlugin } from '@orpc/server/plugins';
import type { StandardHandlerPlugin } from '@orpc/server/standard';
import { CapabilityAuthError } from '../shared/errors.js';
import type {
  ServicePlaneClientCompressionOptions,
  ServicePlaneClientWireOptions,
  ServicePlaneServerCompressionOptions,
  ServicePlaneServerWireOptions,
} from './wire-options.js';

/** Compiles stable client feature options into private engine plugins. */
export function createRpcClientPlugins(options: ServicePlaneClientWireOptions): StandardLinkPlugin<object>[] {
  const plugins: StandardLinkPlugin<object>[] = [];
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
    const request = typeof compression.request === 'boolean' ? {} : compression.request;
    plugins.push(new RequestCompressionLinkPlugin(request));
  }
  if (compression.response) {
    const response = typeof compression.response === 'boolean' ? {} : compression.response;
    plugins.push(new ResponseCompressionLinkPlugin(response));
  }
  return plugins;
}

/** Compiles stable server feature options into private engine plugins. */
export function createRpcHandlerPlugins(
  options: ServicePlaneServerWireOptions,
  hibernation: boolean,
): StandardHandlerPlugin<Record<PropertyKey, unknown>>[] {
  const plugins: StandardHandlerPlugin<Record<PropertyKey, unknown>>[] = [];
  if (options.batch) {
    const batch = typeof options.batch === 'boolean' ? {} : options.batch;
    plugins.push(new BatchHandlerPlugin(batch.maxSize === undefined ? {} : { maxSize: validateBatchSize(batch.maxSize) }));
  }

  const compression = normalizeServerCompression(options.compression);
  if (compression.request) plugins.push(new RequestCompressionHandlerPlugin());
  if (compression.response) {
    const response = typeof compression.response === 'boolean' ? {} : compression.response;
    plugins.push(new ResponseCompressionHandlerPlugin(response));
  }
  if (hibernation) plugins.push(new HibernationHandlerPlugin());
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
