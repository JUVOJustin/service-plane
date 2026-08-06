import { describe, expect, it } from 'vitest';
import { MAX_SERVICE_PLANE_TIMEOUT_MS, normalizeTimeoutMs, parseTimeoutMs, remainingTimeoutMs, serializeTimeoutMs } from './deadline.js';

describe('normalizeTimeoutMs', () => {
  it('keeps a usable budget and clamps one above the ceiling', () => {
    expect(normalizeTimeoutMs(250)).toBe(250);
    expect(normalizeTimeoutMs(MAX_SERVICE_PLANE_TIMEOUT_MS + 1)).toBe(MAX_SERVICE_PLANE_TIMEOUT_MS);
  });

  it('drops anything that is not a positive integer count of milliseconds', () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '250', null, undefined, {}]) {
      expect(normalizeTimeoutMs(value)).toBeUndefined();
    }
  });
});

describe('parseTimeoutMs', () => {
  it('reads the wire form a peer sends', () => {
    expect(parseTimeoutMs('250')).toBe(250);
    expect(parseTimeoutMs(' 250 ')).toBe(250);
  });

  it('refuses a value that is not plain digits, and clamps an oversized one', () => {
    for (const value of ['', '   ', 'soon', '-5', '1e9', '25.5', '0', '9'.repeat(13), null, undefined]) {
      expect(parseTimeoutMs(value)).toBeUndefined();
    }
    expect(parseTimeoutMs(String(MAX_SERVICE_PLANE_TIMEOUT_MS * 2))).toBe(MAX_SERVICE_PLANE_TIMEOUT_MS);
  });
});

describe('serializeTimeoutMs', () => {
  it('round-trips through the wire form', () => {
    expect(parseTimeoutMs(serializeTimeoutMs(1_000))).toBe(1_000);
  });

  it('emits nothing for a value a peer would reject', () => {
    expect(serializeTimeoutMs(undefined)).toBeUndefined();
    expect(serializeTimeoutMs(0)).toBeUndefined();
  });
});

describe('remainingTimeoutMs', () => {
  it('subtracts this hop and floors at zero rather than going negative', () => {
    expect(remainingTimeoutMs(1_000, 250)).toBe(1_000 - 250);
    expect(remainingTimeoutMs(1_000, 1_000)).toBe(0);
    expect(remainingTimeoutMs(1_000, 5_000)).toBe(0);
  });

  it('distinguishes no deadline from an exhausted one', () => {
    expect(remainingTimeoutMs(undefined, 10)).toBeUndefined();
    expect(remainingTimeoutMs(10, 10)).toBe(0);
  });

  it('ignores a nonsensical elapsed reading instead of inventing budget', () => {
    expect(remainingTimeoutMs(1_000, -50)).toBe(1_000);
    expect(remainingTimeoutMs(1_000, Number.NaN)).toBe(1_000);
  });
});
