import { CapabilityAuthError } from './errors.js';

/** Error raised before an oversized request or WebSocket message reaches a protocol decoder. */
export class ServicePlaneBodyTooLargeError extends CapabilityAuthError {
  constructor(message: string) {
    super(message, 413);
    this.name = 'ServicePlaneBodyTooLargeError';
  }
}

/** Validates one configured byte limit while preserving the option-specific error message. */
export function validateBodyByteLimit(value: number, errorMessage: string): number {
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new CapabilityAuthError(errorMessage, 500);
}

/** Resolves a byte limit that can explicitly disable itself. */
export function resolveOptionalBodyByteLimit(value: false | number | undefined, fallback: number, errorMessage: string): false | number {
  return value === false ? false : validateBodyByteLimit(value ?? fallback, errorMessage);
}

/** Reads one HTTP body and rejects it once its cumulative bytes exceed the configured limit. */
export async function readBoundedRequestText(request: Request, maxBytes: number, tooLargeMessage: string): Promise<string> {
  return new TextDecoder().decode(await readBoundedRequestBytes(request, maxBytes, tooLargeMessage));
}

/** Reads one HTTP request body as exact bytes and cancels its reader at the configured limit. */
export async function readBoundedRequestBytes(request: Request, maxBytes: number, tooLargeMessage: string): Promise<Uint8Array> {
  return readBoundedBodyBytes(request, maxBytes, () => new ServicePlaneBodyTooLargeError(tooLargeMessage));
}

/** Reads a cloned request body for authentication without consuming the protocol parser's branch. */
export async function boundedRequestBodyBytes(
  request: Request,
  maxBodyBytes: number | undefined,
  options: {
    invalidMaxBodyBytesMessage: string;
    tooLargeMessage: string;
  },
): Promise<Uint8Array> {
  if (maxBodyBytes !== undefined) validateBodyByteLimit(maxBodyBytes, options.invalidMaxBodyBytesMessage);
  return readBoundedBodyBytes(request.clone(), maxBodyBytes, () => new ServicePlaneBodyTooLargeError(options.tooLargeMessage));
}

/** Reads and parses a trusted-network JSON response without buffering an unbounded body. */
export async function readBoundedResponseJson(
  response: Response,
  maxBytes: number,
  options: { invalidJsonMessage: string; tooLargeMessage: string },
): Promise<unknown> {
  validateBodyByteLimit(maxBytes, 'Service-Plane response body limit must be a positive safe integer');
  const bytes = await readBoundedBodyBytes(response, maxBytes, () => new CapabilityAuthError(options.tooLargeMessage, 500));
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CapabilityAuthError(options.invalidJsonMessage, 500);
  }
}

async function readBoundedBodyBytes(
  source: { body: ReadableStream<Uint8Array> | null; headers: Headers },
  maxBytes: number | undefined,
  tooLargeError: () => Error,
): Promise<Uint8Array> {
  const declaredBytes = Number(source.headers.get('content-length'));
  if (maxBytes !== undefined && Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    try {
      void source.body?.cancel().catch(() => undefined);
    } catch {
      // A body already locked elsewhere is still rejected without reading another byte here.
    }
    throw tooLargeError();
  }
  if (!source.body) return new Uint8Array();

  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (maxBytes !== undefined && byteLength > maxBytes) {
        // A cloned Request is backed by a teed stream. Node waits for both branches before the
        // cancellation promise settles, while the authentication branch may intentionally remain
        // unread. Signal cancellation without making the 413 response wait on that other branch.
        void reader.cancel().catch(() => undefined);
        throw tooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Normalizes a WebSocket frame only after checking its decoded byte length. */
export async function readBoundedWebSocketMessage(
  message: unknown,
  maxBytes: false | number,
  tooLargeMessage: string,
): Promise<string | ArrayBuffer> {
  if (typeof message === 'string') {
    if (maxBytes === false) return message;
    // UTF-8 never needs fewer bytes than a JavaScript string has UTF-16 code units. Rejecting this
    // lower bound first avoids allocating an encoded copy for obviously oversized text frames.
    assertBodyByteLength(message.length, maxBytes, tooLargeMessage);
    assertBodyByteLength(new TextEncoder().encode(message).byteLength, maxBytes, tooLargeMessage);
    return message;
  }
  if (message instanceof Blob) {
    // Blob.size is available without materializing its bytes.
    assertBodyByteLength(message.size, maxBytes, tooLargeMessage);
    return message.arrayBuffer();
  }
  if (message instanceof ArrayBuffer) {
    assertBodyByteLength(message.byteLength, maxBytes, tooLargeMessage);
    return message;
  }
  if (ArrayBuffer.isView(message)) {
    assertBodyByteLength(message.byteLength, maxBytes, tooLargeMessage);
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength).slice().buffer;
  }
  throw new CapabilityAuthError('Service-Plane WebSocket message must be text or binary data', 400);
}

/** Closes an automatically managed socket without letting an adapter error escape its event loop. */
export function closeOversizedWebSocket(webSocket: { close(code?: number, reason?: string): unknown }): void {
  try {
    webSocket.close(1009, 'Message too large');
  } catch {
    // The peer may already be closing; the oversized message remains discarded either way.
  }
}

function assertBodyByteLength(byteLength: number, maxBytes: false | number, message: string): void {
  if (maxBytes !== false && byteLength > maxBytes) throw new ServicePlaneBodyTooLargeError(message);
}
