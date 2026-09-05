import { ServicePlaneBodyTooLargeError } from './body-limit.js';

type FetchRequestPreparationOptions = {
  /** Absolute deadline measured from request entry. Undefined leaves preparation unbounded. */
  deadlineAt?: number;
  /** Classified failure returned when the request has not decoded before the deadline. */
  deadlineError: () => Error;
  /** Other body branches, such as the request exposed to authentication middleware. */
  linkedRequests?: readonly Request[];
};

/** Internal ceiling for turning one physical Fetch request into logical RPC calls. */
export const DEFAULT_RPC_REQUEST_PREPARATION_TIMEOUT_MS = 10_000;

/** Bounds the physical body before authentication and protocol decoding can create separate branches. */
export function requestWithBoundedBody(
  request: Request,
  maxBytes: false | number,
  tooLargeMessage: string,
  onTooLarge?: (error: ServicePlaneBodyTooLargeError) => void,
): Request {
  if (maxBytes === false || !request.body) return request;
  const declaredBytes = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    void request.body.cancel().catch(() => undefined);
    throw new ServicePlaneBodyTooLargeError(tooLargeMessage);
  }

  let bytes = 0;
  const body = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          const error = new ServicePlaneBodyTooLargeError(tooLargeMessage);
          onTooLarge?.(error);
          throw error;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return runtimePreservingRequest(request, { body, duplex: 'half' } as RequestInit & { duplex: 'half' });
}

/**
 * Bounds protocol decoding before an RPC procedure exists to enforce its own deadline. The timer is
 * disarmed at the first procedure entry; logical calls then keep their normal per-call budgets.
 */
export function createFetchRequestPreparation(request: Request, options: FetchRequestPreparationOptions) {
  const deadlineController = new AbortController();
  const sources = [request, ...(options.linkedRequests ?? [])];
  const signal = AbortSignal.any([...sources.map((source) => source.signal), deadlineController.signal]);
  const preparedRequests = sources.map((source) => requestWithAbortableBody(source, signal));
  const prepared = preparedRequests[0] as ReturnType<typeof requestWithAbortableBody>;
  const releaseRequests = () => {
    for (const item of preparedRequests) item.release();
  };
  let disarmed = false;
  let deadlineFailure: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const disarm = () => {
    disarmed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const expire = () => {
    deadlineFailure ??= options.deadlineError();
    if (!deadlineController.signal.aborted) deadlineController.abort(deadlineFailure);
    return deadlineFailure;
  };

  return {
    /** Refuses late procedure dispatch, then hands deadline ownership to the logical call. */
    complete() {
      signal.throwIfAborted();
      if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) throw expire();
      disarm();
    },
    request: prepared.request,
    /** Runs the private decoder while releasing a response that arrives after timeout. */
    run<T>(operation: () => Promise<T>, discardLateValue?: (value: T) => void): Promise<T> {
      try {
        signal.throwIfAborted();
        if (!disarmed && options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) throw expire();
      } catch (error) {
        releaseRequests();
        return Promise.reject(error);
      }
      const deadlineAt = options.deadlineAt;
      if (deadlineAt === undefined || disarmed) {
        try {
          return operation().finally(releaseRequests);
        } catch (error) {
          releaseRequests();
          return Promise.reject(error);
        }
      }
      return new Promise<T>((resolve, reject) => {
        let lost = false;
        const timeout = () => {
          if (disarmed || lost) return;
          lost = true;
          timer = undefined;
          const error = expire();
          reject(error);
        };
        const remaining = deadlineAt - Date.now();
        timer = setTimeout(timeout, Math.max(0, remaining));

        let pending: Promise<T>;
        try {
          pending = operation();
        } catch (error) {
          disarm();
          releaseRequests();
          reject(error);
          return;
        }
        pending.then(
          (value) => {
            if (lost) {
              releaseRequests();
              discardLateValue?.(value);
              return;
            }
            if (!disarmed && deadlineAt !== undefined && Date.now() >= deadlineAt) {
              lost = true;
              const error = expire();
              disarm();
              releaseRequests();
              discardLateValue?.(value);
              reject(error);
              return;
            }
            disarm();
            releaseRequests();
            resolve(value);
          },
          (error: unknown) => {
            if (lost) return;
            disarm();
            releaseRequests();
            reject(error);
          },
        );
      });
    },
    linkedRequests: preparedRequests.slice(1).map((item) => item.request),
    signal,
  };
}

function requestWithAbortableBody(request: Request, signal: AbortSignal): { release(): void; request: Request } {
  if (!request.body) return { release: () => undefined, request: runtimePreservingRequest(request, { signal }) };

  const reader = request.body.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finished = false;

  const release = () => {
    try {
      reader.releaseLock();
    } catch {
      // A pending read still owns the lock; its settle path will release it.
    }
  };
  const cancelReader = (reason: unknown) => {
    try {
      void reader
        .cancel(reason)
        .catch(() => undefined)
        .finally(release);
    } catch {
      release();
    }
  };
  const fail = (reason: unknown) => {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', onAbort);
    cancelReader(reason);
    try {
      controller?.error(reason);
    } catch {
      // The consumer may already have cancelled the wrapper stream.
    }
  };
  const onAbort = () => fail(signal.reason);

  const body = new ReadableStream<Uint8Array>({
    cancel(reason) {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', onAbort);
      cancelReader(reason);
    },
    async pull(streamController) {
      if (signal.aborted) {
        fail(signal.reason);
        return;
      }
      try {
        const result = await reader.read();
        if (finished) return;
        if (result.done) {
          finished = true;
          signal.removeEventListener('abort', onAbort);
          release();
          streamController.close();
          return;
        }
        streamController.enqueue(result.value);
      } catch (error) {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        release();
        streamController.error(error);
      }
    },
    start(streamController) {
      controller = streamController;
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
  });

  // Node requires `duplex: 'half'` for a streaming request body. Fetch runtimes ignore the
  // extension, and the cast keeps that runtime-only field out of the public DOM type surface.
  return {
    release: () => fail(new DOMException('RPC request decoding completed', 'AbortError')),
    request: runtimePreservingRequest(request, { body, duplex: 'half', signal } as RequestInit & { duplex: 'half' }),
  };
}

function runtimePreservingRequest(request: Request, init: RequestInit): Request {
  return preserveRuntimeRequestMetadata(request, new Request(request, init));
}

/** Copies runtime-owned request metadata that the web-standard constructor does not preserve. */
export function preserveRuntimeRequestMetadata(source: Request, derived: Request): Request {
  // Cloudflare attaches request.cf outside the web-standard Request fields copied by constructors.
  // Keep it visible whenever a logical RPC request replaces the physical request in Hono context.
  try {
    const cf = (source as Request & { cf?: unknown }).cf;
    if (cf !== undefined && (derived as Request & { cf?: unknown }).cf === undefined) {
      Object.defineProperty(derived, 'cf', { configurable: true, enumerable: true, value: cf });
    }
  } catch {
    // A runtime-owned accessor must not make request preparation fail.
  }
  return derived;
}
