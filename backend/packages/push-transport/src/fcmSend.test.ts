import { generateKeyPairSync } from 'node:crypto';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetPushCredentialCaches } from './pushCredentials.js';
import {
  fetchRetryingConnectionLoss,
  isNonRetryableRefusal,
  nextRequestTimeout,
} from './pushResult.js';
import { sendFcm } from './fcmSend.js';

/** Package-home behavior tests for the FCM side and the budget helpers (review m1). */

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const RSA_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function fcmSecret(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    project_id: 'boxalarm-test',
    client_email: 'svc@boxalarm-test.iam.gserviceaccount.com',
    private_key: RSA_PEM,
    ...overrides,
  });
}

function secretsClient(secretString: string): {
  client: SecretsManagerClient;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue({ SecretString: secretString });
  return { client: { send } as unknown as SecretsManagerClient, send };
}

interface FakeResponses {
  oauth?: { status: number; body: unknown };
  send: { status: number; body: unknown }[];
}

/** Routes the two endpoints sendFcm talks to; records every messages:send body. */
function stubFetch(responses: FakeResponses): { bodies: string[] } {
  const bodies: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('oauth2.googleapis.com') || target.includes('/token')) {
        const oauth = responses.oauth ?? {
          status: 200,
          body: { access_token: 'at-1', expires_in: 3600 },
        };
        return Promise.resolve(new Response(JSON.stringify(oauth.body), { status: oauth.status }));
      }
      bodies.push(typeof init?.body === 'string' ? init.body : '');
      const next = responses.send.shift() ?? { status: 200, body: { name: 'projects/x/m/1' } };
      return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status }));
    }),
  );
  return { bodies };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetPushCredentialCaches();
});

const send = (secrets: ReturnType<typeof secretsClient>, options: Record<string, unknown> = {}) =>
  sendFcm(
    {
      buildRequest: (credentials) => ({ message: { token: 'tok-1', meta: credentials.projectId } }),
    },
    {
      secretId: 'fcm-prod',
      isTest: false,
      secretsClient: secrets.client,
      timeoutMs: 4_000,
      ...options,
    },
  );

describe('sendFcm classification', () => {
  it('a 200 with a name is sent, and the body comes from buildRequest(credentials)', async () => {
    const { bodies } = stubFetch({ send: [{ status: 200, body: { name: 'projects/x/m/9' } }] });

    await expect(send(secretsClient(fcmSecret()))).resolves.toEqual({
      outcome: 'sent',
      providerMessageId: 'projects/x/m/9',
    });
    expect(JSON.parse(bodies[0]!)).toEqual({ message: { token: 'tok-1', meta: 'boxalarm-test' } });
  });

  it('UNREGISTERED is a dead token', async () => {
    stubFetch({
      send: [
        {
          status: 404,
          body: { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } },
        },
      ],
    });
    await expect(send(secretsClient(fcmSecret()))).resolves.toEqual({
      outcome: 'invalid_token',
      reason: 'FCM_UNREGISTERED',
    });
  });

  it('INVALID_ARGUMENT is a dead token only when it names the token field', async () => {
    stubFetch({
      send: [
        {
          status: 400,
          body: {
            error: {
              status: 'INVALID_ARGUMENT',
              details: [
                { errorCode: 'INVALID_ARGUMENT', fieldViolations: [{ field: 'message.token' }] },
              ],
            },
          },
        },
      ],
    });
    await expect(send(secretsClient(fcmSecret()))).resolves.toEqual({
      outcome: 'invalid_token',
      reason: 'FCM_INVALID_ARGUMENT',
    });
  });

  it('any other INVALID_ARGUMENT is a payload bug and stays loud', async () => {
    stubFetch({
      send: [
        {
          status: 400,
          body: { error: { status: 'INVALID_ARGUMENT', message: 'bad ttl' } },
        },
      ],
    });
    await expect(send(secretsClient(fcmSecret()))).rejects.toThrow(
      'FCM responded 400 INVALID_ARGUMENT',
    );
  });

  it('a 401 evicts the cached credentials and retries once before throwing', async () => {
    stubFetch({
      send: [
        { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } },
        { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } },
      ],
    });
    const secrets = secretsClient(fcmSecret());

    await expect(send(secrets)).rejects.toThrow('FCM responded 401');
    expect(secrets.send).toHaveBeenCalledTimes(2);
  });

  it('a 500 throws so SQS redelivers', async () => {
    stubFetch({ send: [{ status: 500, body: {} }] });
    await expect(send(secretsClient(fcmSecret()))).rejects.toThrow('FCM responded 500');
  });
});

describe('budget and retry helpers', () => {
  it('nextRequestTimeout caps at the per-request timeout and throws once the budget is gone', () => {
    const now = Date.now();
    expect(nextRequestTimeout(4_000, now + 10_000)).toBe(4_000);
    expect(nextRequestTimeout(4_000, now + 1_000)).toBeLessThanOrEqual(1_000);
    expect(() => nextRequestTimeout(4_000, now - 1)).toThrow('budget exhausted');
  });

  it('isNonRetryableRefusal: 4xx except 429', () => {
    expect(isNonRetryableRefusal(400)).toBe(true);
    expect(isNonRetryableRefusal(404)).toBe(true);
    expect(isNonRetryableRefusal(429)).toBe(false);
    expect(isNonRetryableRefusal(503)).toBe(false);
  });

  it('fetchRetryingConnectionLoss retries exactly once, and only on a connection loss', async () => {
    const loss = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'UND_ERR_SOCKET' },
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(loss)
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchRetryingConnectionLoss('https://x.invalid', {}, () => 1_000);
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const httpError = new Error('nope');
    fetchMock.mockReset().mockRejectedValue(httpError);
    await expect(fetchRetryingConnectionLoss('https://x.invalid', {}, () => 1_000)).rejects.toBe(
      httpError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
