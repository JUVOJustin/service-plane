import type { RpcTransport } from 'capnweb';

/**
 * Build a connected pair of in-memory `RpcTransport`s for unit tests. Each
 * transport's `send` writes into the other's inbound queue. Either side may
 * be passed to `new RpcSession(...)` to drive a Cap'n Web session without a
 * real network or worker.
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
  push(value: string): void;
  pull(): Promise<string>;
  abort(error: Error): void;
};

function createQueue(): Queue {
  const messages: string[] = [];
  const waiters: Array<{ resolve: (value: string) => void; reject: (error: Error) => void }> = [];
  let aborted: Error | undefined;
  return {
    push(value) {
      if (aborted) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve(value);
      } else {
        messages.push(value);
      }
    },
    pull() {
      if (aborted) return Promise.reject(aborted);
      const next = messages.shift();
      if (next !== undefined) return Promise.resolve(next);
      return new Promise<string>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    abort(error) {
      aborted = error;
      while (waiters.length > 0) {
        waiters.shift()!.reject(error);
      }
    },
  };
}

function createTransport(outbound: Queue, inbound: Queue): RpcTransport {
  return {
    async send(message) {
      outbound.push(message);
    },
    receive() {
      return inbound.pull();
    },
    abort(reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
      outbound.abort(error);
      inbound.abort(error);
    },
  };
}
