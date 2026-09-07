import { describe, expect, it } from 'vitest';
import { emitBestEffortServicePlaneLog } from './logging.js';

const event = { event: 'service_plane.test', level: 'info' as const };

describe('best-effort Service Plane logging', () => {
  it('contains synchronous sink failures', () => {
    expect(() =>
      emitBestEffortServicePlaneLog(() => {
        throw new Error('sink failed');
      }, event),
    ).not.toThrow();
  });

  it('handles rejected async sinks', async () => {
    emitBestEffortServicePlaneLog(async () => {
      throw new Error('async sink failed');
    }, event);

    await Promise.resolve();
    await Promise.resolve();
  });
});
