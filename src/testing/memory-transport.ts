import type { RpcTransport } from 'capnweb';

/**
 * In-memory Cap'n Web transport used by tests that should not bind real sockets.
 */
export function memoryRpcTransportPair(): { left: RpcTransport; right: RpcTransport } {
  const leftToRight = createQueue();
  const rightToLeft = createQueue();
  return {
    left: createTransport(leftToRight, rightToLeft),
    right: createTransport(rightToLeft, leftToRight),
  };
}

type Queue = {
  abort(error: Error): void;
  pull(): Promise<string>;
  push(value: string): void;
};

function createQueue(): Queue {
  const messages: string[] = [];
  const waiters: Array<{ reject: (error: Error) => void; resolve: (value: string) => void }> = [];
  let aborted: Error | undefined;

  return {
    abort(error) {
      aborted = error;
      while (waiters.length > 0) {
        waiters.shift()?.reject(error);
      }
    },
    pull() {
      if (aborted) return Promise.reject(aborted);
      const next = messages.shift();
      if (next !== undefined) return Promise.resolve(next);
      return new Promise<string>((resolve, reject) => {
        waiters.push({ reject, resolve });
      });
    },
    push(value) {
      if (aborted) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve(value);
        return;
      }
      messages.push(value);
    },
  };
}

function createTransport(outbound: Queue, inbound: Queue): RpcTransport {
  return {
    abort(reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
      outbound.abort(error);
      inbound.abort(error);
    },
    receive() {
      return inbound.pull();
    },
    async send(message) {
      outbound.push(message);
    },
  };
}
