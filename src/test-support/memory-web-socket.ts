// In-memory WebSocket pair for exercising oRPC WebSocket links without a network.

/** Minimal in-memory WebSocket peer implementing the surface oRPC links and handlers touch. */
export class MemoryWebSocket extends EventTarget {
  attachment?: unknown;
  peer?: MemoryWebSocket;
  readyState = 1 as const;

  // oRPC's links register async message/close listeners. workerd's EventTarget warns when a
  // listener returns a promise, so wrap function listeners to swallow the return value while
  // keeping removeEventListener identity intact.
  #wrappedListeners = new WeakMap<EventListener, EventListener>();

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    super.addEventListener(type, this.wrapListener(listener), options);
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    super.removeEventListener(type, this.wrapListener(listener), options);
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void {
    queueMicrotask(() => this.peer?.dispatchEvent(new MessageEvent('message', { data })));
  }

  serializeAttachment(attachment: unknown): void {
    this.attachment = attachment;
  }

  private wrapListener(listener: EventListenerOrEventListenerObject | null): EventListenerOrEventListenerObject | null {
    if (typeof listener !== 'function') return listener;
    let wrapped = this.#wrappedListeners.get(listener);
    if (!wrapped) {
      wrapped = (event) => {
        void listener(event);
      };
      this.#wrappedListeners.set(listener, wrapped);
    }
    return wrapped;
  }
}

/** Creates two connected in-memory WebSocket peers. */
export function memoryWebSocketPair(): [MemoryWebSocket, MemoryWebSocket] {
  const left = new MemoryWebSocket();
  const right = new MemoryWebSocket();
  left.peer = right;
  right.peer = left;
  return [left, right];
}
