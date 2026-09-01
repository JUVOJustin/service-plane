import { describe, expect, it } from 'vitest';
import { servicePlaneClientError, servicePlaneErrorInfo } from './errors.js';

function wireError(status: unknown): unknown {
  return {
    data: {
      servicePlane: {
        code: 'internal',
        message: 'peer failure',
        retryable: false,
        status,
      },
    },
  };
}

describe('Service Plane wire errors', () => {
  it.each([399, 600, -1, Number.NaN, 401.5])('rejects an invalid HTTP-style status (%s)', (status) => {
    expect(servicePlaneErrorInfo(wireError(status))).toBeUndefined();
  });

  it.each([400, 404, 500, 599])('accepts a valid HTTP-style status (%s)', (status) => {
    expect(servicePlaneErrorInfo(wireError(status))).toMatchObject({ code: 'internal', status });
  });

  it('classifies failures from a locally aborted signal as cancelled', () => {
    const controller = new AbortController();
    controller.abort(new DOMException('caller stopped', 'AbortError'));

    expect(servicePlaneClientError(new Error('private transport failure'), controller.signal)).toMatchObject({
      code: 'cancelled',
      message: 'caller stopped',
      retryable: false,
      status: 499,
    });
  });

  it.each([
    ['BAD_REQUEST', 400],
    ['UNAUTHORIZED', 401],
    ['PAYMENT_REQUIRED', 402],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['METHOD_NOT_SUPPORTED', 405],
    ['NOT_ACCEPTABLE', 406],
    ['TIMEOUT', 408],
    ['CONFLICT', 409],
    ['GONE', 410],
    ['PRECONDITION_FAILED', 412],
    ['PAYLOAD_TOO_LARGE', 413],
    ['UNSUPPORTED_MEDIA_TYPE', 415],
    ['UNPROCESSABLE_CONTENT', 422],
    ['PRECONDITION_REQUIRED', 428],
    ['TOO_MANY_REQUESTS', 429],
    ['CLIENT_CLOSED_REQUEST', 499],
    ['INTERNAL_SERVER_ERROR', 500],
    ['NOT_IMPLEMENTED', 501],
    ['BAD_GATEWAY', 502],
    ['SERVICE_UNAVAILABLE', 503],
    ['GATEWAY_TIMEOUT', 504],
  ] as const)('maps a private transport %s failure to status %s', (code, status) => {
    expect(servicePlaneClientError({ code })).toMatchObject({ code: 'internal', status });
  });
});
