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
}
