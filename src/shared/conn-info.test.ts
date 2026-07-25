import { describe, expect, it } from 'vitest';
import { type ConnInfo, normalizeConnInfo, parseConnInfo, serializeConnInfo } from './conn-info.js';

describe('forwarded connection info', () => {
  it('round-trips the fields Hono defines', () => {
    const connInfo = { remote: { address: '203.0.113.7', addressType: 'IPv4', port: 44_321, transport: 'tcp' } } as ConnInfo;
    const serialized = serializeConnInfo(connInfo);
    expect(serialized).toBe('{"address":"203.0.113.7","addressType":"IPv4","port":44321,"transport":"tcp"}');
    expect(parseConnInfo(serialized)).toEqual(connInfo);
    expect(parseConnInfo(serializeConnInfo({ remote: { address: '[2001:db8::1%eth0]', addressType: 'IPv6' } } as ConnInfo))).toEqual({
      remote: { address: '[2001:db8::1%eth0]', addressType: 'IPv6' },
    });
  });

  it('drops values that could smuggle separators or lie about the shape', () => {
    // A header value must not be able to inject a newline, a second header, or a huge log line.
    expect(normalizeConnInfo({ remote: { address: '203.0.113.7\r\nX-Injected: 1' } } as ConnInfo)).toBeUndefined();
    expect(normalizeConnInfo({ remote: { address: 'a'.repeat(256) } } as ConnInfo)).toBeUndefined();
    expect(normalizeConnInfo({ remote: { port: 70_000 } } as unknown as ConnInfo)).toBeUndefined();
    expect(normalizeConnInfo({ remote: { port: 1.5 } } as unknown as ConnInfo)).toBeUndefined();
    expect(normalizeConnInfo({ remote: { transport: 'quic' } } as unknown as ConnInfo)).toBeUndefined();
    expect(normalizeConnInfo({ remote: {} } as ConnInfo)).toBeUndefined();
    expect(normalizeConnInfo(undefined)).toBeUndefined();
  });

  it('keeps addressType paired with an address', () => {
    // Hono's NetAddrInfo only carries addressType alongside an address; a lone type says nothing.
    expect(normalizeConnInfo({ remote: { addressType: 'IPv4', port: 443 } } as unknown as ConnInfo)).toEqual({ remote: { port: 443 } });
  });

  it('rejects wire values that are not a connection-info object', () => {
    expect(parseConnInfo(undefined)).toBeUndefined();
    expect(parseConnInfo('')).toBeUndefined();
    expect(parseConnInfo('not json')).toBeUndefined();
    expect(parseConnInfo('[{"address":"203.0.113.7"}]')).toBeUndefined();
    expect(parseConnInfo('"203.0.113.7"')).toBeUndefined();
    expect(parseConnInfo(`{"address":"${'a'.repeat(600)}"}`)).toBeUndefined();
    // Unknown fields are dropped rather than passed through to handlers.
    expect(parseConnInfo('{"address":"203.0.113.7","evil":"x"}')).toEqual({ remote: { address: '203.0.113.7' } });
  });
});
