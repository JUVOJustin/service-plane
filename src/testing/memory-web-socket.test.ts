import { describe, expect, it, vi } from 'vitest';
import type { AbilityClientWebSocket } from '../service/client.js';
import { memoryWebSocketPair } from './memory-web-socket.js';

describe('memory WebSocket pair', () => {
  it('is accepted by the public client socket factory surface and exchanges frames', async () => {
    const [left, right] = memoryWebSocketPair();
    const clientSocket: AbilityClientWebSocket = left;
    const received = vi.fn();
    right.addEventListener('message', (event) => received((event as MessageEvent).data));

    clientSocket.send('hello');

    await vi.waitFor(() => expect(received).toHaveBeenCalledWith('hello'));
  });

  it('closes both peers once and rejects frames after close', async () => {
    const [left, right] = memoryWebSocketPair();
    const leftClosed = vi.fn();
    const rightClosed = vi.fn();
    left.addEventListener('close', leftClosed);
    right.addEventListener('close', rightClosed);

    left.close(1000, 'done');
    left.close(1000, 'again');

    await vi.waitFor(() => {
      expect(left.readyState).toBe(3);
      expect(right.readyState).toBe(3);
    });
    expect(leftClosed).toHaveBeenCalledTimes(1);
    expect(rightClosed).toHaveBeenCalledTimes(1);
    expect(() => left.send('late')).toThrowError(/not open/u);
  });
});
