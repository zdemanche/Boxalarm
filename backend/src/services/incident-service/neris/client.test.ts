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

describe('nerisFetch', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('always attaches User-Agent and Authorization even when the call site omits headers', async () => {
    const { createNerisClient } = await import('./client.js');
    const { createTokenCache } = await import('./tokenCache.js');

    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/token')) {
        return Promise.resolve(
          jsonResponse({ access_token: 'access-abc', expires_in: 3600, token_type: 'Bearer' }),
        );
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const client = createNerisClient(CONFIG, {
      fetchFn,
      tokenCache: createTokenCache(),
      nowMs: () => 1_000_000,
    });

    const response = await client.fetch('/entity/FD1');
    expect(response.ok).toBe(true);

    const apiCalls = fetchFn.mock.calls.filter((call) => !String(call[0]).endsWith('/token'));
    expect(apiCalls).toHaveLength(1);
    const [url, init] = apiCalls[0] as [string, RequestInit];
    expect(url).toBe('https://api-test.neris.fsri.org/v1/entity/FD1');
    const headers = new Headers(init.headers);
    expect(headers.get('User-Agent')).toBe('BoxalarmIncidentService-Dev/1.0');
    expect(headers.get('Authorization')).toBe('Bearer access-abc');
  });

  it('overwrites a call-site User-Agent so the header cannot be omitted or replaced', async () => {
    const { createNerisClient } = await import('./client.js');
    const { createTokenCache } = await import('./tokenCache.js');

    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/token')) {
        return Promise.resolve(
          jsonResponse({ access_token: 'access-abc', expires_in: 3600, token_type: 'Bearer' }),
        );
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const client = createNerisClient(CONFIG, {
      fetchFn,
      tokenCache: createTokenCache(),
      nowMs: () => 1_000_000,
    });

    await client.fetch('/entity/FD1', {
      headers: {
        'User-Agent': 'malicious-agent/0.0',
        Authorization: 'Bearer forged',
      },
    });

    const apiCalls = fetchFn.mock.calls.filter((call) => !String(call[0]).endsWith('/token'));
    const headers = new Headers((apiCalls[0] as [string, RequestInit])[1].headers);
    expect(headers.get('User-Agent')).toBe('BoxalarmIncidentService-Dev/1.0');
    expect(headers.get('Authorization')).toBe('Bearer access-abc');
  });

  it('reuses a cached token across requests and refreshes near expiry before the API call', async () => {
    const { createNerisClient } = await import('./client.js');
    const { createTokenCache, NEAR_EXPIRY_SKEW_MS } = await import('./tokenCache.js');

    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/token')) {
        const callIndex = fetchFn.mock.calls.filter((c) => String(c[0]).endsWith('/token')).length;
        return Promise.resolve(
          jsonResponse({
            access_token: callIndex === 1 ? 'token-old' : 'token-new',
            expires_in: callIndex === 1 ? 120 : 3600,
            token_type: 'Bearer',
          }),
        );
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const cache = createTokenCache();
    const nowMs = vi.fn().mockReturnValue(1_000_000);
    const client = createNerisClient(CONFIG, { fetchFn, tokenCache: cache, nowMs });

    await client.fetch('/a');
    await client.fetch('/b');
    expect(fetchFn.mock.calls.filter((c) => String(c[0]).endsWith('/token'))).toHaveLength(1);

    nowMs.mockReturnValue(1_000_000 + 120_000 - NEAR_EXPIRY_SKEW_MS + 1);
    await client.fetch('/c');

    const apiCalls = fetchFn.mock.calls.filter((call) => !String(call[0]).endsWith('/token'));
    const lastHeaders = new Headers((apiCalls.at(-1) as [string, RequestInit])[1].headers);
    expect(lastHeaders.get('Authorization')).toBe('Bearer token-new');
    expect(lastHeaders.get('User-Agent')).toBe('BoxalarmIncidentService-Dev/1.0');
    expect(fetchFn.mock.calls.filter((c) => String(c[0]).endsWith('/token'))).toHaveLength(2);
  });

  it('accepts absolute URLs under the configured base and still forces required headers', async () => {
    const { createNerisClient } = await import('./client.js');
    const { createTokenCache } = await import('./tokenCache.js');

    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/token')) {
        return Promise.resolve(
          jsonResponse({ access_token: 'access-abc', expires_in: 3600, token_type: 'Bearer' }),
        );
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const client = createNerisClient(CONFIG, {
      fetchFn,
      tokenCache: createTokenCache(),
      nowMs: () => 1_000_000,
    });

    await client.fetch('https://api-test.neris.fsri.org/v1/entity/FD1');
    const apiCalls = fetchFn.mock.calls.filter((call) => !String(call[0]).endsWith('/token'));
    expect(apiCalls[0]?.[0]).toBe('https://api-test.neris.fsri.org/v1/entity/FD1');
    const headers = new Headers((apiCalls[0] as [string, RequestInit])[1].headers);
    expect(headers.get('User-Agent')).toBe('BoxalarmIncidentService-Dev/1.0');
  });

  it('rejects absolute URLs whose hostname does not match the configured base host', async () => {
    const { createNerisClient } = await import('./client.js');
    const { createTokenCache } = await import('./tokenCache.js');

    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/token')) {
        return Promise.resolve(
          jsonResponse({ access_token: 'access-abc', expires_in: 3600, token_type: 'Bearer' }),
        );
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const client = createNerisClient(CONFIG, {
      fetchFn,
      tokenCache: createTokenCache(),
      nowMs: () => 1_000_000,
    });

    await expect(client.fetch('https://evil.example.com/v1/entity/FD1')).rejects.toThrow(
      /does not match configured base host/i,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('getNerisClient', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns the same client instance on repeated calls (module-scope singleton)', async () => {
    const { getNerisClient } = await import('./client.js');
    const a = getNerisClient(CONFIG);
    const b = getNerisClient(CONFIG);
    expect(a).toBe(b);
  });

  it('reuses the client and its token cache across separate calls, so a later invocation does not refetch a still-usable token', async () => {
    const { getNerisClient } = await import('./client.js');

    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/token')) {
        return Promise.resolve(
          jsonResponse({ access_token: 'access-abc', expires_in: 3600, token_type: 'Bearer' }),
        );
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    // First "invocation": wires deps, as a cold-start handler would.
    const first = getNerisClient(CONFIG, { fetchFn, nowMs: () => 1_000_000 });
    await first.fetch('/a');

    // Second "invocation": calls getNerisClient again with no deps, the way a
    // handler naively would — must still return the warm, cached client.
    const second = getNerisClient(CONFIG);
    await second.fetch('/b');

    expect(second).toBe(first);
    const tokenCalls = fetchFn.mock.calls.filter((c) => String(c[0]).endsWith('/token'));
    expect(tokenCalls).toHaveLength(1);
  });
});

describe('resolveUrl', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('joins relative paths against the configured base', async () => {
    const { resolveUrl } = await import('./client.js');
    expect(resolveUrl('https://api-test.neris.fsri.org/v1', '/entity/FD1')).toBe(
      'https://api-test.neris.fsri.org/v1/entity/FD1',
    );
    expect(resolveUrl('https://api-test.neris.fsri.org/v1/', 'entity/FD1')).toBe(
      'https://api-test.neris.fsri.org/v1/entity/FD1',
    );
  });

  it('allows absolute URLs on the configured hostname', async () => {
    const { resolveUrl } = await import('./client.js');
    expect(
      resolveUrl('https://api-test.neris.fsri.org/v1', 'https://api-test.neris.fsri.org/other'),
    ).toBe('https://api-test.neris.fsri.org/other');
  });

  it('rejects absolute URLs on a different hostname', async () => {
    const { resolveUrl } = await import('./client.js');
    expect(() =>
      resolveUrl('https://api-test.neris.fsri.org/v1', 'https://api.neris.fsri.org/v1/entity'),
    ).toThrow(/does not match configured base host/i);
  });
});
