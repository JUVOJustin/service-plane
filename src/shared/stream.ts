import { ServicePlaneError } from './errors.js';

export const SERVICE_PLANE_STREAM_CONTENT_TYPE = 'application/x-ndjson';

// One JSON frame per line. Every stream ends with a terminal `done` or `error` frame so
// consumers can tell completion from truncation: the HTTP status is committed before the
// first item flows, so mid-stream failures can only be reported in-band.
export type AbilityStreamFrame = { done: true } | { error: { message: string; status: number } } | { item: unknown };

export function abilityStreamPath(rpcPath: string): string {
  const base = rpcPath.replace(/\/+$/u, '');
  return `${base}/stream`;
}

export function encodeAbilityStreamFrame(frame: AbilityStreamFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export async function* readAbilityStreamFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<AbilityStreamFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) yield parseAbilityStreamFrame(line);
        newline = buffered.indexOf('\n');
      }
    }
    const rest = `${buffered}${decoder.decode()}`.trim();
    if (rest) yield parseAbilityStreamFrame(rest);
  } finally {
    // Also runs when the consumer stops early; cancel releases the upstream connection.
    void reader.cancel().catch(() => undefined);
  }
}

function parseAbilityStreamFrame(line: string): AbilityStreamFrame {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ServicePlaneError('Invalid Service-Plane ability stream frame', 502);
  }
  if (value && typeof value === 'object') {
    const frame = value as Record<string, unknown>;
    if ('item' in frame) return { item: frame.item };
    if (frame.done === true) return { done: true };
    if (frame.error && typeof frame.error === 'object') {
      const error = frame.error as { message?: unknown; status?: unknown };
      return {
        error: {
          message: typeof error.message === 'string' ? error.message : 'Service-Plane ability stream failed',
          status: typeof error.status === 'number' ? error.status : 500,
        },
      };
    }
  }
  throw new ServicePlaneError('Invalid Service-Plane ability stream frame', 502);
}
