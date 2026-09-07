import { describe, expect, it, vi } from 'vitest';
import { ServicePlaneTimeoutError } from './errors.js';
import { createFetchRequestPreparation, requestWithBoundedBody } from './request-preparation.js';

function streamingRequest(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Request {
  return new Request('https://service.internal/rpc/v1/tasks/get', {
    body,
    duplex: 'half',
    method: 'POST',
    ...(signal ? { signal } : {}),
  } as RequestInit & { duplex: 'half' });
}

describe('Fetch request preparation', () => {
  it('preserves exact signed bytes and runtime metadata while bounding both body branches', async () => {
    const bytes = Uint8Array.from([0, 255, 239, 187, 191, 32, 13, 10]);
    const request = new Request('https://service.internal/request?raw=true', {
      body: bytes,
      headers: { 'content-type': 'application/octet-stream', 'x-signature': 'signed' },
      method: 'POST',
    });
    const cf = { colo: 'FRA' };
    Object.defineProperty(request, 'cf', { value: cf });
    const bounded = requestWithBoundedBody(request, bytes.length, 'oversized');
    const decoding = bounded.clone();

    expect(new Uint8Array(await bounded.arrayBuffer())).toEqual(bytes);
    expect(new Uint8Array(await decoding.arrayBuffer())).toEqual(bytes);
    expect(bounded.url).toBe(request.url);
    expect(bounded.headers.get('x-signature')).toBe('signed');
    expect((bounded as Request & { cf?: unknown }).cf).toBe(cf);
  });

  it('rejects a declared oversized physical request without reading or cloning it', () => {
    let cancelled = false;
    const request = new Request('https://service.internal/request', {
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      duplex: 'half',
      headers: { 'content-length': '4' },
      method: 'POST',
    } as RequestInit);

    expect(() => requestWithBoundedBody(request, 3, 'oversized')).toThrow('oversized');
    expect(cancelled).toBe(true);
  });

  it('preserves Cloudflare request metadata on decoder and middleware branches', () => {
    const request = new Request('https://service.internal/rpc/v1/tasks/get');
    const cf = { colo: 'FRA' };
    Object.defineProperty(request, 'cf', { configurable: true, enumerable: true, value: cf });
    const linked = request.clone();
    Object.defineProperty(linked, 'cf', { configurable: true, enumerable: true, value: cf });

    const preparation = createFetchRequestPreparation(request, {
      deadlineError: () => new ServicePlaneTimeoutError('late'),
      linkedRequests: [linked],
    });

    expect((preparation.request as Request & { cf?: unknown }).cf).toBe(cf);
    expect((preparation.linkedRequests[0] as Request & { cf?: unknown }).cf).toBe(cf);
  });

  it('releases an unread body when protocol handling returns early', async () => {
    let cancels = 0;
    const request = streamingRequest(
      new ReadableStream({
        cancel() {
          cancels += 1;
        },
      }),
    );
    const preparation = createFetchRequestPreparation(request, {
      deadlineError: () => new ServicePlaneTimeoutError('late'),
    });

    await expect(preparation.run(async () => 'response')).resolves.toBe('response');
    expect(cancels).toBe(1);
  });

  it('preserves a fully consumed body without cancelling its source', async () => {
    let cancels = 0;
    const request = streamingRequest(
      new ReadableStream({
        cancel() {
          cancels += 1;
        },
        start(controller) {
          controller.enqueue(new TextEncoder().encode('body'));
          controller.close();
        },
      }),
    );
    const preparation = createFetchRequestPreparation(request, {
      deadlineError: () => new ServicePlaneTimeoutError('late'),
    });

    await expect(preparation.run(() => preparation.request.text())).resolves.toBe('body');
    expect(cancels).toBe(0);
  });

  it('refuses late procedure entry and discards a result that arrives after timeout', async () => {
    vi.useFakeTimers();
    let resolveOperation: ((value: string) => void) | undefined;
    let discarded: string | undefined;
    try {
      const preparation = createFetchRequestPreparation(new Request('https://service.internal/rpc/v1/tasks/get'), {
        deadlineAt: Date.now() + 20,
        deadlineError: () => new ServicePlaneTimeoutError('decode timed out'),
      });
      const result = preparation.run(
        () =>
          new Promise<string>((resolve) => {
            resolveOperation = resolve;
          }),
        (value) => {
          discarded = value;
        },
      );
      const rejected = expect(result).rejects.toMatchObject({ code: 'timeout', status: 504 });

      await vi.advanceTimersByTimeAsync(20);
      await rejected;
      expect(() => preparation.complete()).toThrow('decode timed out');
      resolveOperation?.('late response');
      await Promise.resolve();
      expect(discarded).toBe('late response');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an already-expired budget before synchronous decoder dispatch can start', async () => {
    let started = false;
    const preparation = createFetchRequestPreparation(new Request('https://service.internal/rpc/v1/tasks/get'), {
      deadlineAt: Date.now() - 1,
      deadlineError: () => new ServicePlaneTimeoutError('decode already timed out'),
    });

    const result = preparation.run(async () => {
      started = true;
      preparation.complete();
      return 'late response';
    });

    await expect(result).rejects.toMatchObject({ code: 'timeout', message: 'decode already timed out', status: 504 });
    expect(started).toBe(false);
    expect(() => preparation.complete()).toThrow('decode already timed out');
  });

  it('checks the absolute deadline when decoder settlement wins the timer queue race', async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let discarded: string | undefined;
    try {
      const preparation = createFetchRequestPreparation(new Request('https://service.internal/rpc/v1/tasks/get'), {
        deadlineAt: 1_010,
        deadlineError: () => new ServicePlaneTimeoutError('decode settled too late'),
      });
      const result = preparation.run(
        async () => {
          now = 1_010;
          return 'late response';
        },
        (value) => {
          discarded = value;
        },
      );

      await expect(result).rejects.toMatchObject({ code: 'timeout', message: 'decode settled too late', status: 504 });
      expect(discarded).toBe('late response');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('cancels a pending body read when the original request is aborted', async () => {
    const controller = new AbortController();
    let cancels = 0;
    const request = streamingRequest(
      new ReadableStream({
        cancel() {
          cancels += 1;
        },
        pull: () => new Promise<void>(() => undefined),
      }),
      controller.signal,
    );
    const preparation = createFetchRequestPreparation(request, {
      deadlineError: () => new ServicePlaneTimeoutError('late'),
    });
    const reading = preparation.run(() => preparation.request.text());

    controller.abort(new DOMException('caller left', 'AbortError'));

    await expect(reading).rejects.toThrow('caller left');
    expect(cancels).toBe(1);
  });
});
