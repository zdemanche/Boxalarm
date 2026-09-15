import { describe, expect, it, vi } from 'vitest';
import { createConfigCache } from './cache.js';

describe('createConfigCache', () => {
  it('returns a cached value within the TTL without calling the loader again', async () => {
    const loader = vi.fn(() => Promise.resolve({ version: 1, value: { n: 1 } }));
    const cache = createConfigCache({ ttlMs: 60_000, now: () => 1_000 });

    const first = await cache.getOrLoad('DEPT#d1', 'CONFIG#ALERT_RULES', loader);
    const second = await cache.getOrLoad('DEPT#d1', 'CONFIG#ALERT_RULES', loader);

    expect(first).toEqual({ version: 1, value: { n: 1 } });
    expect(second).toEqual(first);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('falls back to the loader when the TTL has expired', async () => {
    let now = 1_000;
    const loader = vi
      .fn()
      .mockResolvedValueOnce({ version: 1, value: { n: 1 } })
      .mockResolvedValueOnce({ version: 2, value: { n: 2 } });
    const cache = createConfigCache({ ttlMs: 5_000, now: () => now });

    await cache.getOrLoad('DEPT#d1', 'CONFIG#ALERT_RULES', loader);
    now = 7_000;
    const refreshed = await cache.getOrLoad('DEPT#d1', 'CONFIG#ALERT_RULES', loader);

    expect(refreshed).toEqual({ version: 2, value: { n: 2 } });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('falls back to DynamoDB loader when the cache store throws', async () => {
    const loader = vi.fn(() => Promise.resolve({ version: 3, value: { ok: true } }));
    const cache = createConfigCache({
      ttlMs: 60_000,
      now: () => 1_000,
      store: {
        get() {
          throw new Error('valkey unavailable');
        },
        set() {
          throw new Error('valkey unavailable');
        },
        delete() {
          /* ignore */
        },
      },
    });

    const result = await cache.getOrLoad('DEPT#d1', 'CONFIG#STATIONS', loader);

    expect(result).toEqual({ version: 3, value: { ok: true } });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('invalidates a key so the next read reloads from the loader', async () => {
    const loader = vi
      .fn()
      .mockResolvedValueOnce({ version: 1, value: { a: 1 } })
      .mockResolvedValueOnce({ version: 2, value: { a: 2 } });
    const cache = createConfigCache({ ttlMs: 60_000, now: () => 1_000 });

    await cache.getOrLoad('DEPT#d1', 'CONFIG#RANKS', loader);
    cache.invalidate('DEPT#d1', 'CONFIG#RANKS');
    const next = await cache.getOrLoad('DEPT#d1', 'CONFIG#RANKS', loader);

    expect(next).toEqual({ version: 2, value: { a: 2 } });
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
