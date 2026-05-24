import { CapabilityAuthError } from './errors.js';

export async function boundedRequestBodyBytes(
  request: Request,
  maxBodyBytes: number | undefined,
  options: {
    invalidMaxBodyBytesMessage: string;
    tooLargeMessage: string;
  },
): Promise<Uint8Array> {
  if (maxBodyBytes !== undefined) {
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
      throw new CapabilityAuthError(options.invalidMaxBodyBytesMessage, 500);
    }
    const contentLength = request.headers.get('content-length');
    if (contentLength) {
      const parsed = Number(contentLength);
      if (Number.isFinite(parsed) && parsed > maxBodyBytes) {
        throw new CapabilityAuthError(options.tooLargeMessage, 413);
      }
    }
  }

  const body = request.clone().body;
  if (!body) return new Uint8Array();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (maxBodyBytes !== undefined && totalBytes > maxBodyBytes) {
      void reader.cancel().catch(() => undefined);
      throw new CapabilityAuthError(options.tooLargeMessage, 413);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
