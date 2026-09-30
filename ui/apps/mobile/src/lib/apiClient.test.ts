import { ApiError, ApiTimeoutError, apiRequest, DEFAULT_TIMEOUT_MS } from './apiClient';

const tokens = { getAccessToken: async () => 'access', renewSilently: async () => null };
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  jest.useRealTimers();
});

/** A fetch that never answers until its signal aborts - a half-dead LTE link. */
function hangingFetch(): jest.Mock {
  return jest.fn(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
      }),
  );
}

test('a request with no answer fails with ApiTimeoutError after the default limit instead of hanging', async () => {
  jest.useFakeTimers();
  globalThis.fetch = hangingFetch() as unknown as typeof fetch;

  const pending = apiRequest('alerting/dispatches/D1', tokens, { apiBaseUrl: 'https://api.test' });
  const assertion = expect(pending).rejects.toBeInstanceOf(ApiTimeoutError);
  await jest.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
  await assertion;
});

test('a caller can set a shorter limit for the alert path', async () => {
  jest.useFakeTimers();
  globalThis.fetch = hangingFetch() as unknown as typeof fetch;

  const pending = apiRequest('x', tokens, { apiBaseUrl: 'https://api.test', timeoutMs: 3_000 });
  const assertion = expect(pending).rejects.toMatchObject({ timeoutMs: 3_000 });
  await jest.advanceTimersByTimeAsync(3_000);
  await assertion;
});

test('an answered request is returned and its timer does not fire later', async () => {
  globalThis.fetch = jest.fn(
    async () => new Response('{}', { status: 200 }),
  ) as unknown as typeof fetch;

  const response = await apiRequest('x', tokens, { apiBaseUrl: 'https://api.test' });
  expect(response.ok).toBe(true);
});

test('a network failure that is not a timeout keeps its own error', async () => {
  globalThis.fetch = jest.fn(async () => {
    throw new TypeError('Network request failed');
  }) as unknown as typeof fetch;

  await expect(apiRequest('x', tokens, { apiBaseUrl: 'https://api.test' })).rejects.toBeInstanceOf(
    TypeError,
  );
});

test('a 4xx still surfaces as ApiError with the problem status', async () => {
  globalThis.fetch = jest.fn(
    async () => new Response(JSON.stringify({ title: 'Forbidden', status: 403 }), { status: 403 }),
  ) as unknown as typeof fetch;

  await expect(apiRequest('x', tokens, { apiBaseUrl: 'https://api.test' })).rejects.toBeInstanceOf(
    ApiError,
  );
});

test('a token fetch that never answers fails with ApiTimeoutError instead of hanging the request', async () => {
  jest.useFakeTimers();
  const fetchSpy = jest.fn();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  const hangingTokens = {
    getAccessToken: () => new Promise<string | null>(() => {}),
    renewSilently: async () => null,
  };

  const pending = apiRequest('x', hangingTokens, {
    apiBaseUrl: 'https://api.test',
    timeoutMs: 2_000,
  });
  const assertion = expect(pending).rejects.toBeInstanceOf(ApiTimeoutError);
  await jest.advanceTimersByTimeAsync(2_000);
  await assertion;
  expect(fetchSpy).not.toHaveBeenCalled();
});
