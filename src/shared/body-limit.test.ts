import { describe, expect, it, vi } from 'vitest';
import {
  closeOversizedWebSocket,
  readBoundedRequestText,
  readBoundedResponseJson,
  readBoundedWebSocketMessage,
  ServicePlaneBodyTooLargeError,
} from './body-limit.js';

describe('bounded transport bodies', () => {
  it('counts WebSocket strings in UTF-8 bytes and accepts exactly the limit', async () => {
    await expect(readBoundedWebSocketMessage('é', 2, 'too large')).resolves.toBe('é');
    await expect(readBoundedWebSocketMessage('é', 1, 'too large')).rejects.toMatchObject({
      message: 'too large',
      status: 413,
    });
  });

  it('skips UTF-8 encoding when disabled or when the code-unit lower bound already exceeds the limit', async () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
      await expect(readBoundedWebSocketMessage('é'.repeat(8), false, 'too large')).resolves.toBe('é'.repeat(8));
      await expect(readBoundedWebSocketMessage('1234', 3, 'too large')).rejects.toBeInstanceOf(ServicePlaneBodyTooLargeError);
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });

  it('checks Blob.size before reading and preserves exact ArrayBuffer and view ranges', async () => {
    const blob = new Blob(['12345']);
    const arrayBuffer = vi.spyOn(blob, 'arrayBuffer');
    await expect(readBoundedWebSocketMessage(blob, 4, 'too large')).rejects.toBeInstanceOf(ServicePlaneBodyTooLargeError);
    expect(arrayBuffer).not.toHaveBeenCalled();

    const bytes = Uint8Array.from([1, 2, 3, 4]);
    await expect(readBoundedWebSocketMessage(bytes.buffer, 4, 'too large')).resolves.toBe(bytes.buffer);
    const view = new Uint8Array(bytes.buffer, 1, 2);
    const normalized = await readBoundedWebSocketMessage(view, 2, 'too large');
    expect([...new Uint8Array(normalized as ArrayBuffer)]).toEqual([2, 3]);
  });

  it('accepts an HTTP body exactly at the limit and rejects streamed excess', async () => {
    const exact = new Request('https://example.test', { body: 'é', method: 'POST' });
    await expect(readBoundedRequestText(exact, 2, 'too large')).resolves.toBe('é');

    const oversized = new Request('https://example.test', { body: 'é', method: 'POST' });
    await expect(readBoundedRequestText(oversized, 1, 'too large')).rejects.toMatchObject({ status: 413 });
  });

  it('uses content-length for a fast rejection and closes oversized sockets safely', async () => {
    const declared = new Request('https://example.test', {
      body: 'x',
      headers: { 'content-length': '2' },
      method: 'POST',
    });
    await expect(readBoundedRequestText(declared, 1, 'too large')).rejects.toMatchObject({ status: 413 });

    const close = vi.fn(() => {
      throw new Error('already closed');
    });
    expect(() => closeOversizedWebSocket({ close })).not.toThrow();
    expect(close).toHaveBeenCalledWith(1009, 'Message too large');
  });

  it('bounds trusted-network JSON responses by declared and streamed bytes', async () => {
    await expect(
      readBoundedResponseJson(new Response('{"ok":true}'), 11, {
        invalidJsonMessage: 'invalid',
        tooLargeMessage: 'upstream too large',
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      readBoundedResponseJson(new Response('{"ok":true}'), 10, {
        invalidJsonMessage: 'invalid',
        tooLargeMessage: 'upstream too large',
      }),
    ).rejects.toMatchObject({ message: 'upstream too large', status: 500 });
    await expect(
      readBoundedResponseJson(new Response('not-json', { headers: { 'content-length': '999' } }), 8, {
        invalidJsonMessage: 'invalid',
        tooLargeMessage: 'declared too large',
      }),
    ).rejects.toMatchObject({ message: 'declared too large', status: 500 });
    await expect(
      readBoundedResponseJson(new Response('not-json'), 8, {
        invalidJsonMessage: 'invalid',
        tooLargeMessage: 'too large',
      }),
    ).rejects.toMatchObject({ message: 'invalid', status: 500 });
  });

  it('cancels a response body rejected from its declared length', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { 'content-length': '999' },
    });

    await expect(
      readBoundedResponseJson(response, 8, {
        invalidJsonMessage: 'invalid',
        tooLargeMessage: 'declared too large',
      }),
    ).rejects.toMatchObject({ message: 'declared too large', status: 500 });

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });
});
