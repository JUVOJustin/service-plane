const memoryWebSocketPeers = new WeakMap<MemoryWebSocket, MemoryWebSocket>();

/** Small standards-shaped WebSocket used for transport tests without opening a network socket. */
export class MemoryWebSocket extends EventTarget {
  #attachment: unknown;
  #wrappedListeners = new WeakMap<EventListener, EventListener>();

  /** Current WebSocket ready state (`OPEN` initially). */
  readyState: 0 | 1 | 2 | 3 = 1;

  /** Reads the Durable Object-style attachment stored on this peer. */
  deserializeAttachment(): unknown {
    return this.#attachment;
  }

  /** Closes both connected peers and dispatches their close events asynchronously. */
  close(code = 1000, reason = ''): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    const peer = memoryWebSocketPeers.get(this);
    if (peer && peer.readyState < 2) peer.readyState = 2;
    queueMicrotask(() => {
      this.finishClose(code, reason);
      peer?.finishClose(code, reason);
    });
  }

  /** Delivers one frame asynchronously to the connected peer. */
  send(data: Parameters<WebSocket['send']>[0]): void {
    if (this.readyState !== 1) throw new DOMException('WebSocket is not open', 'InvalidStateError');
    queueMicrotask(() => memoryWebSocketPeers.get(this)?.dispatchEvent(new MessageEvent('message', { data })));
  }

  /** Stores a Durable Object-style attachment on this peer. */
  serializeAttachment(attachment: unknown): void {
    this.#attachment = attachment;
  }

  /** Wraps function listeners so workerd never observes their async return values. */
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    super.addEventListener(type, this.wrapListener(listener), options);
  }

  /** Reuses the cached wrapper identity so function listeners remain removable. */
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    super.removeEventListener(type, this.wrapListener(listener), options);
  }

  private finishClose(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const event = new Event('close');
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
    });
    this.dispatchEvent(event);
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

/** Creates two connected, initially open in-memory WebSocket peers. */
export function memoryWebSocketPair(): [MemoryWebSocket, MemoryWebSocket] {
  const left = new MemoryWebSocket();
  const right = new MemoryWebSocket();
  memoryWebSocketPeers.set(left, right);
  memoryWebSocketPeers.set(right, left);
  return [left, right];
}
