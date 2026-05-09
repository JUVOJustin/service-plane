import { describe, expect, it } from 'vitest';
import { MachineAuthError } from './errors.js';
import { signMachineRequest, verifyMachineRequest } from './crypto.js';

describe('HMAC machine auth', () => {
  it('signs and verifies a request without sending the secret', async () => {
    const request = new Request('https://service.test/v1/sync?x=1', {
      body: JSON.stringify({ ok: true }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    const signed = await signMachineRequest(request, {
      now: new Date('2026-05-09T12:00:00.000Z'),
      secret: 'very-secret',
    });

    expect(signed.headers.get('Service-Plane-Signature')).toMatch(/^hmac-sha256=:/u);
    expect(signed.headers.get('authorization')).toBeNull();
    await expect(
      verifyMachineRequest(signed, {
        now: new Date('2026-05-09T12:01:00.000Z'),
        resolveSecret: () => 'very-secret',
      }),
    ).resolves.toMatchObject({ keyId: 'default', timestamp: '2026-05-09T12:00:00.000Z' });
  });

  it('rejects tampered bodies', async () => {
    const signed = await signMachineRequest(
      new Request('https://service.test/v1/sync', {
        body: JSON.stringify({ ok: true }),
        method: 'POST',
      }),
      {
        now: new Date('2026-05-09T12:00:00.000Z'),
        secret: 'very-secret',
      },
    );
    const tampered = new Request(signed.url, {
      body: JSON.stringify({ ok: false }),
      headers: signed.headers,
      method: signed.method,
    });

    await expect(
      verifyMachineRequest(tampered, {
        now: new Date('2026-05-09T12:00:01.000Z'),
        resolveSecret: () => 'very-secret',
      }),
    ).rejects.toThrow(MachineAuthError);
  });

  it('rejects expired timestamps', async () => {
    const signed = await signMachineRequest(new Request('https://service.test/v1/sync'), {
      now: new Date('2026-05-09T12:00:00.000Z'),
      secret: 'very-secret',
    });

    await expect(
      verifyMachineRequest(signed, {
        maxSkewSeconds: 300,
        now: new Date('2026-05-09T12:06:00.000Z'),
        resolveSecret: () => 'very-secret',
      }),
    ).rejects.toThrow('Expired Service-Plane signature');
  });

  it('rejects path tampering', async () => {
    const signed = await signMachineRequest(new Request('https://service.test/v1/sync'), {
      now: new Date('2026-05-09T12:00:00.000Z'),
      secret: 'very-secret',
    });
    const tampered = new Request('https://service.test/v1/other', {
      headers: signed.headers,
      method: signed.method,
    });

    await expect(
      verifyMachineRequest(tampered, {
        now: new Date('2026-05-09T12:00:01.000Z'),
        resolveSecret: () => 'very-secret',
      }),
    ).rejects.toThrow('Invalid Service-Plane signature');
  });
});
