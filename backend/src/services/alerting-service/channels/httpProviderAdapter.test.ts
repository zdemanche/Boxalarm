import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

function fakeSecretsClient(secretString: string | undefined): {
  client: SecretsManagerClient;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue({ SecretString: secretString });
  return { client: { send } as unknown as SecretsManagerClient, send };
}

beforeEach(() => {
  vi.resetModules();
  process.env.PUSH_PROVIDER_ENDPOINT_URL = 'https://push.example';
  process.env.PUSH_PROVIDER_SECRET_ID = 'push-secret';
});

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
});

describe('readChannelProviderConfig', () => {
  it.each([['PUSH_PROVIDER_ENDPOINT_URL'], ['PUSH_PROVIDER_SECRET_ID']])(
    'throws when %s is not set (fail closed, no network call)',
    async (missingKey) => {
      const { readChannelProviderConfig } = await import('./httpProviderAdapter.js');
      const env: NodeJS.ProcessEnv = {
        PUSH_PROVIDER_ENDPOINT_URL: 'https://push.example',
        PUSH_PROVIDER_SECRET_ID: 'push-secret',
        [missingKey]: undefined,
      };
      expect(() => readChannelProviderConfig('push', env)).toThrow(
        `${missingKey} is required and was not set`,
      );
    },
  );
});

describe('sendViaHttpProvider', () => {
  it('resolves the api key from Secrets Manager and posts target+message with bearer auth', async () => {
    const { client, send } = fakeSecretsClient('api-key-1');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    globalThis.fetch = fetchMock;
    const { sendViaHttpProvider } = await import('./httpProviderAdapter.js');

    await sendViaHttpProvider(
      'push',
      'push-token-1',
      'structure-fire — 12 Main St',
      process.env,
      client,
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://push.example');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer api-key-1' });
    expect((init as RequestInit).body).toBe(
      JSON.stringify({ target: 'push-token-1', message: 'structure-fire — 12 Main St' }),
    );
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects when the provider connection accepts but never responds (bounded by the abort signal)', async () => {
    const { client } = fakeSecretsClient('api-key-1');
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () =>
            reject(new Error('TimeoutError')),
          );
        }),
    );
    globalThis.fetch = fetchMock;
    const { sendViaHttpProvider } = await import('./httpProviderAdapter.js');

    const pending = sendViaHttpProvider('push', 'push-token-1', 'msg', process.env, client);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal | undefined;
    signal?.dispatchEvent(new Event('abort'));

    await expect(pending).rejects.toThrow('TimeoutError');
  });

  it('throws when the provider responds with a non-ok status', async () => {
    const { client } = fakeSecretsClient('api-key-1');
    globalThis.fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: false, status: 503 } as Response);
    const { sendViaHttpProvider } = await import('./httpProviderAdapter.js');

    await expect(
      sendViaHttpProvider('push', 'push-token-1', 'msg', process.env, client),
    ).rejects.toThrow('push provider responded 503');
  });

  it('throws when the secret has no SecretString value, never falling back to an env literal', async () => {
    const { client } = fakeSecretsClient(undefined);
    const { sendViaHttpProvider } = await import('./httpProviderAdapter.js');

    await expect(
      sendViaHttpProvider('push', 'push-token-1', 'msg', process.env, client),
    ).rejects.toThrow('has no SecretString value');
  });

  it('caches the resolved secret across sends on the hot delivery path (one GetSecretValueCommand for two sends)', async () => {
    const { client, send } = fakeSecretsClient('api-key-1');
    globalThis.fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const { sendViaHttpProvider } = await import('./httpProviderAdapter.js');

    await sendViaHttpProvider('push', 'push-token-1', 'msg', process.env, client);
    await sendViaHttpProvider('push', 'push-token-2', 'msg', process.env, client);

    expect(send).toHaveBeenCalledTimes(1);
  });
});
