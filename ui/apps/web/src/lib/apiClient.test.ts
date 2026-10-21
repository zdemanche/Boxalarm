import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, apiRequest, type AuthTokenSource } from './apiClient';

const tokens: AuthTokenSource = {
  getAccessToken: async () => 'token',
  renewSilently: async () => null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

async function failure(status: number, body: unknown): Promise<ApiError> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
  return apiRequest('platform/x', tokens).then(
    () => {
      throw new Error('expected rejection');
    },
    (error: unknown) => error as ApiError,
  );
}

test('a gateway refusal body surfaces its message instead of an empty one', async () => {
  const error = await failure(403, { message: 'Forbidden' });
  expect(error).toBeInstanceOf(ApiError);
  expect(error.message).toBe('Forbidden');
  expect(error.problem.status).toBeUndefined();
  expect(error.problem.title).toBeUndefined();
});

test('a non-object error body gets the about:blank problem with a status message', async () => {
  const error = await failure(503, ['a', 'b']);
  expect(error.message).toBe('Request failed (HTTP 503)');
  expect(error.problem.type).toBe('about:blank');
  expect(Object.keys(error.problem)).not.toContain('0');
});

test('a body without a message falls back to the HTTP status', async () => {
  const error = await failure(503, {});
  expect(error.message).toBe('Request failed (HTTP 503)');
});

test('a problem+json body keeps its own title and status', async () => {
  const error = await failure(403, { title: 'Forbidden', status: 403, traceId: 't' });
  expect(error.message).toBe('Forbidden');
  expect(error.problem.status).toBe(403);
});
