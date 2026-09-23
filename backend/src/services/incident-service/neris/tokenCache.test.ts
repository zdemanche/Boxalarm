import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NerisConfig } from './config.js';

const CONFIG: NerisConfig = {
  baseUrl: 'https://api-test.neris.fsri.org/v1',
  userAgent: 'BoxalarmIncidentService-Dev/1.0',
  clientId: 'dev-client-id',
  clientSecret: 'dev-client-secret',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('getAccessToken', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('acquires a token via client_credentials with Basic auth and User-Agent', async () => {
    const { getAccessToken, createTokenCache } = await import('./tokenCache.js');
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ access_token: 'token-1', expires_in: 3600, token_type: 'Bearer' }),
      );
    const cache = createTokenCache();

    const token = await getAccessToken(CONFIG, { fetchFn, cache, nowMs: () => 1_000_000 });

    expect(token).toBe('token-1');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api-test.neris.fsri.org/v1/token');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('User-Agent')).toBe('BoxalarmIncidentService-Dev/1.0');
    expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    const expectedBasic = Buffer.from('dev-client-id:dev-client-secret').toString('base64');
    expect(headers.get('Authorization')).toBe(`Basic ${expectedBasic}`);
    expect(init.body).toBe('grant_type=client_credentials');
  });

  it('returns the cached token without calling the token endpoint again', async () => {
    const { getAccessToken, createTokenCache } = await import('./tokenCache.js');
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ access_token: 'token-1', expires_in: 3600, token_type: 'Bearer' }),
      );
    const cache = createTokenCache();
    const nowMs = vi.fn().mockReturnValue(1_000_000);

    const first = await getAccessToken(CONFIG, { fetchFn, cache, nowMs });
    nowMs.mockReturnValue(1_000_000 + 30_000);
    const second = await getAccessToken(CONFIG, { fetchFn, cache, nowMs });

    expect(first).toBe('token-1');
    expect(second).toBe('token-1');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the cached token is near expiry without failing the in-flight request', async () => {
    const { getAccessToken, createTokenCache, NEAR_EXPIRY_SKEW_MS } =
      await import('./tokenCache.js');
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'token-old', expires_in: 120, token_type: 'Bearer' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'token-new', expires_in: 3600, token_type: 'Bearer' }),
      );
    const cache = createTokenCache();
    const acquiredAt = 1_000_000;

    await getAccessToken(CONFIG, { fetchFn, cache, nowMs: () => acquiredAt });

    // Advance to within the near-expiry skew of the original expires_in.
    const nearExpiryAt = acquiredAt + 120_000 - NEAR_EXPIRY_SKEW_MS + 1;
    const refreshed = await getAccessToken(CONFIG, {
      fetchFn,
      cache,
      nowMs: () => nearExpiryAt,
    });

    expect(refreshed).toBe('token-new');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws a non-secret error when the token endpoint returns a non-OK status', async () => {
    const { getAccessToken, createTokenCache } = await import('./tokenCache.js');
    const fetchFn = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    const cache = createTokenCache();

    await expect(
      getAccessToken(CONFIG, { fetchFn, cache, nowMs: () => 1_000_000 }),
    ).rejects.toThrow(/token endpoint|401/i);

    await expect(
      getAccessToken(CONFIG, { fetchFn, cache, nowMs: () => 1_000_000 }),
    ).rejects.not.toThrow(/dev-client-secret|token-1/);
  });

  it('throws when the token response omits access_token', async () => {
    const { getAccessToken, createTokenCache } = await import('./tokenCache.js');
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ expires_in: 3600 }));
    const cache = createTokenCache();

    await expect(
      getAccessToken(CONFIG, { fetchFn, cache, nowMs: () => 1_000_000 }),
    ).rejects.toThrow(/access_token/i);
  });

  it('coalesces concurrent calls with an expired/empty cache into a single token request', async () => {
    const { getAccessToken, createTokenCache } = await import('./tokenCache.js');
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchFn = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const cache = createTokenCache();

    const first = getAccessToken(CONFIG, { fetchFn, cache, nowMs: () => 1_000_000 });
    const second = getAccessToken(CONFIG, { fetchFn, cache, nowMs: () => 1_000_000 });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    resolveFetch?.(jsonResponse({ access_token: 'token-shared', expires_in: 3600 }));

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe('token-shared');
    expect(b).toBe('token-shared');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(cache.get()?.accessToken).toBe('token-shared');
  });

  it('clears the in-flight slot on failure so a later call retries instead of coalescing forever', async () => {
    const { getAccessToken, createTokenCache } = await import('./tokenCache.js');
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-retry', expires_in: 3600 }));
    const cache = createTokenCache();

    await expect(
      getAccessToken(CONFIG, { fetchFn, cache, nowMs: () => 1_000_000 }),
    ).rejects.toThrow(/500/);

    const token = await getAccessToken(CONFIG, { fetchFn, cache, nowMs: () => 1_000_000 });
    expect(token).toBe('token-retry');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not coalesce across distinct cache instances', async () => {
    const { getAccessToken, createTokenCache } = await import('./tokenCache.js');
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-a', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-b', expires_in: 3600 }));

    const [a, b] = await Promise.all([
      getAccessToken(CONFIG, { fetchFn, cache: createTokenCache(), nowMs: () => 1_000_000 }),
      getAccessToken(CONFIG, { fetchFn, cache: createTokenCache(), nowMs: () => 1_000_000 }),
    ]);

    expect(new Set([a, b])).toEqual(new Set(['token-a', 'token-b']));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('getTokenCache', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns the same cache instance on repeated calls (module-scope singleton)', async () => {
    const { getTokenCache } = await import('./tokenCache.js');
    const a = getTokenCache();
    const b = getTokenCache();
    expect(a).toBe(b);
  });

  it('preserves a cached token across separate getTokenCache() calls', async () => {
    const { getTokenCache } = await import('./tokenCache.js');
    getTokenCache().set({ accessToken: 'persisted', expiresAtMs: 1_000_000 });
    expect(getTokenCache().get()?.accessToken).toBe('persisted');
  });
});
