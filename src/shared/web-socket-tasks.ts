import { closeOversizedWebSocket, readBoundedWebSocketMessage, ServicePlaneBodyTooLargeError } from './body-limit.js';

export type WebSocketDeliveryOptions = {
  /** Closes the socket on an oversized frame instead of rejecting; manually driven sockets keep the rejection. */
  closeOnOversized?: boolean;
  /** Maximum decoded frame size, or `false` for no limit. */
  maxBytes: false | number;
  /** Hands the normalized frame to the private peer and returns its completion. */
  send: (data: string | ArrayBuffer) => Promise<unknown>;

  tooLargeMessage: string;
};

/** Serializes asynchronous WebSocket work independently for each physical socket. */
export class OrderedWebSocketTasks {
  private readonly tails = new WeakMap<object, Promise<void>>();

  /**
   * Reserves a socket's next turn synchronously, before frame normalization can yield. A rejected
   * task does not poison later frames because the stored tail always settles successfully.
   */
  run<T>(webSocket: object, task: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(webSocket) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(webSocket, tail);
    void tail.then(() => {
      if (this.tails.get(webSocket) === tail) this.tails.delete(webSocket);
    });
    return result;
  }

  /**
   * Normalizes one inbound frame in the socket's turn, then hands it to the private peer. The turn
   * covers only normalization and synchronous delivery: the RPC itself stays concurrent with later
   * frames on the same socket, matching the private engine's own upgrader.
   */
  async deliver(webSocket: object, message: unknown, options: WebSocketDeliveryOptions): Promise<void> {
    const delivered = await this.run(webSocket, async () => {
      let data: string | ArrayBuffer;
      try {
        data = await readBoundedWebSocketMessage(message, options.maxBytes, options.tooLargeMessage);
      } catch (error) {
        if (!options.closeOnOversized || !(error instanceof ServicePlaneBodyTooLargeError)) throw error;
        closeOversizedWebSocket(webSocket as { close(code?: number, reason?: string): unknown });
        return undefined;
      }
      return { completion: options.send(data) };
    });
    await delivered?.completion;
  }
}
