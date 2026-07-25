import type { ConnInfo } from 'hono/conninfo';

// `hono/conninfo` ships types only — every runtime's `getConnInfo` lives in its own adapter
// (`hono/cloudflare-workers`, `hono/deno`, `hono/bun`, `@hono/node-server/conninfo`) — so this
// type import adds no runtime code and keeps the package portable. Consumers supply the getter.
export type { ConnInfo };

// Forwarded connection info is an unsigned assertion by the plane about a connection the service
// never saw. It is advisory: use it for audit and logging, never as an authorization input.
export const SERVICE_PLANE_CONN_INFO_HEADER = 'X-Service-Plane-Conn-Info';
// WebSocket upgrades cannot carry custom headers portably, mirroring the request id.
export const SERVICE_PLANE_CONN_INFO_QUERY_PARAM = 'conn_info';

// Bounded so a hostile or buggy value cannot smuggle header separators, blow up a log line, or
// arrive as anything but the shape Hono defines. Covers IPv4, bracketed IPv6 with zone ids, and
// host names.
const ADDRESS_PATTERN = /^[A-Za-z0-9.:_\-[\]%]{1,255}$/u;
const MAX_SERIALIZED_BYTES = 512;

// Applied on both send and receive: the plane must not emit a value the service would reject, and
// the service must not trust a value merely because it arrived from the plane.
export function normalizeConnInfo(connInfo: ConnInfo | undefined): ConnInfo | undefined {
  const remote = connInfo?.remote;
  if (!remote) return undefined;
  const address = typeof remote.address === 'string' && ADDRESS_PATTERN.test(remote.address) ? remote.address : undefined;
  const addressType = remote.addressType === 'IPv4' || remote.addressType === 'IPv6' ? remote.addressType : undefined;
  const port =
    typeof remote.port === 'number' && Number.isInteger(remote.port) && remote.port >= 0 && remote.port <= 65535 ? remote.port : undefined;
  const transport = remote.transport === 'tcp' || remote.transport === 'udp' ? remote.transport : undefined;
  if (address === undefined && port === undefined && transport === undefined) return undefined;
  return {
    remote: {
      ...(address === undefined ? {} : { address }),
      // Hono's NetAddrInfo pairs addressType with address; a type without an address says nothing.
      ...(address === undefined || addressType === undefined ? {} : { addressType }),
      ...(port === undefined ? {} : { port }),
      ...(transport === undefined ? {} : { transport }),
    },
  } as ConnInfo;
}

export function serializeConnInfo(connInfo: ConnInfo | undefined): string | undefined {
  const normalized = normalizeConnInfo(connInfo);
  if (!normalized) return undefined;
  const serialized = JSON.stringify(normalized.remote);
  return serialized.length <= MAX_SERIALIZED_BYTES ? serialized : undefined;
}

export function parseConnInfo(value: string | null | undefined): ConnInfo | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > MAX_SERIALIZED_BYTES) return undefined;
  let remote: unknown;
  try {
    remote = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof remote !== 'object' || remote === null || Array.isArray(remote)) return undefined;
  return normalizeConnInfo({ remote } as ConnInfo);
}
