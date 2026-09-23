import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { SSMClient } from '@aws-sdk/client-ssm';

function fakeSsmClient(values: Record<string, string>): {
  client: SSMClient;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockImplementation((command: { input: { Name: string } }) => {
    const name = command.input.Name;
    const value = values[name];
    if (value === undefined) {
      return Promise.reject(new Error(`Parameter ${name} not found`));
    }
    return Promise.resolve({ Parameter: { Name: name, Value: value } });
  });
  return { client: { send } as unknown as SSMClient, send };
}

function fakeSecretsClient(secretString: string | undefined): {
  client: SecretsManagerClient;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue({ SecretString: secretString });
  return { client: { send } as unknown as SecretsManagerClient, send };
}

/** Non-prod Boxalarm — N6.4 production-host fail-closed applies. */
const DEV_ENV: NodeJS.ProcessEnv = {
  STAGE: 'dev',
  NERIS_BASE_URL_PARAM: '/boxalarm/dev/neris/base-url',
  NERIS_USER_AGENT_PARAM: '/boxalarm/dev/neris/user-agent',
  NERIS_CREDENTIALS_SECRET_ID: 'boxalarm/dev/neris/credentials',
};

const PROD_ENV: NodeJS.ProcessEnv = {
  STAGE: 'prod',
  NERIS_BASE_URL_PARAM: '/boxalarm/prod/neris/base-url',
  NERIS_USER_AGENT_PARAM: '/boxalarm/prod/neris/user-agent',
  NERIS_CREDENTIALS_SECRET_ID: 'boxalarm/prod/neris/credentials',
};

describe('isBoxalarmProductionEnvironment', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it.each([
    [{ STAGE: 'prod' }, true],
    [{ STAGE: 'production' }, true],
    [{ STAGE: 'PROD' }, true],
    [{ BOXALARM_ENV: 'prod' }, true],
    [{ BOXALARM_ENV: 'production' }, true],
    [{ STAGE: 'dev' }, false],
    [{ STAGE: 'staging' }, false],
    [{ BOXALARM_ENV: 'dev' }, false],
    [{}, false],
  ])('returns %s for env %j', async (env, expected) => {
    const { isBoxalarmProductionEnvironment } = await import('./config.js');
    expect(isBoxalarmProductionEnvironment(env)).toBe(expected);
  });

  it('prefers STAGE over BOXALARM_ENV', async () => {
    const { isBoxalarmProductionEnvironment } = await import('./config.js');
    expect(isBoxalarmProductionEnvironment({ STAGE: 'dev', BOXALARM_ENV: 'prod' })).toBe(false);
  });
});

describe('assertNonProductionBaseUrl', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('allows a non-production base URL (NERIS test host)', async () => {
    const { assertNonProductionBaseUrl } = await import('./config.js');
    expect(() => assertNonProductionBaseUrl('https://api-test.neris.fsri.org/v1')).not.toThrow();
  });

  it('fails closed when the resolved base URL host is the default NERIS production host', async () => {
    const { assertNonProductionBaseUrl, DEFAULT_NERIS_PRODUCTION_HOST } =
      await import('./config.js');
    expect(DEFAULT_NERIS_PRODUCTION_HOST).toBe('api.neris.fsri.org');
    expect(() => assertNonProductionBaseUrl('https://api.neris.fsri.org/v1')).toThrow(
      /NERIS production host|refusing to start/i,
    );
  });

  it('fails closed when NERIS_PRODUCTION_HOST overrides the allowlist and the URL matches', async () => {
    const { assertNonProductionBaseUrl } = await import('./config.js');
    expect(() =>
      assertNonProductionBaseUrl('https://custom-prod.example.com/v1', {
        productionHost: 'custom-prod.example.com',
      }),
    ).toThrow(/NERIS production host|refusing to start/i);
  });

  it('compares hostnames case-insensitively and ignores path/port defaults', async () => {
    const { assertNonProductionBaseUrl } = await import('./config.js');
    expect(() => assertNonProductionBaseUrl('https://API.NERIS.FSRI.ORG/v1/')).toThrow(
      /NERIS production host|refusing to start/i,
    );
  });
});

describe('readNerisConfig', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it.each([['NERIS_BASE_URL_PARAM'], ['NERIS_USER_AGENT_PARAM'], ['NERIS_CREDENTIALS_SECRET_ID']])(
    'throws when %s is not set',
    async (missingKey) => {
      const { readNerisConfig } = await import('./config.js');
      const env: NodeJS.ProcessEnv = { ...DEV_ENV, [missingKey]: undefined };
      await expect(
        readNerisConfig(env, {
          ssmClient: fakeSsmClient({}).client,
          secretsClient: fakeSecretsClient('{}').client,
        }),
      ).rejects.toThrow(`${missingKey} is required and was not set`);
    },
  );

  it('loads base URL and User-Agent from SSM and credentials from Secrets Manager', async () => {
    const { readNerisConfig } = await import('./config.js');
    const { client: ssmClient, send: ssmSend } = fakeSsmClient({
      '/boxalarm/dev/neris/base-url': 'https://api-test.neris.fsri.org/v1',
      '/boxalarm/dev/neris/user-agent': 'BoxalarmIncidentService-Dev/1.0',
    });
    const { client: secretsClient, send: secretsSend } = fakeSecretsClient(
      JSON.stringify({ clientId: 'dev-client-id', clientSecret: 'dev-client-secret' }),
    );

    const config = await readNerisConfig(DEV_ENV, { ssmClient, secretsClient });

    expect(config.baseUrl).toBe('https://api-test.neris.fsri.org/v1');
    expect(config.userAgent).toBe('BoxalarmIncidentService-Dev/1.0');
    expect(config.clientId).toBe('dev-client-id');
    expect(config.clientSecret).toBe('dev-client-secret');

    const ssmNames = ssmSend.mock.calls.map(
      (call) => (call[0] as { input: { Name: string } }).input.Name,
    );
    expect(ssmNames).toEqual(
      expect.arrayContaining(['/boxalarm/dev/neris/base-url', '/boxalarm/dev/neris/user-agent']),
    );
    const secretCommand = secretsSend.mock.calls[0]?.[0] as { input: { SecretId: string } };
    expect(secretCommand.input.SecretId).toBe('boxalarm/dev/neris/credentials');
  });

  it('in non-prod Boxalarm (STAGE=dev), asserts non-production NERIS host and refuses production', async () => {
    const { readNerisConfig } = await import('./config.js');
    const { client: ssmClient } = fakeSsmClient({
      '/boxalarm/dev/neris/base-url': 'https://api.neris.fsri.org/v1',
      '/boxalarm/dev/neris/user-agent': 'BoxalarmIncidentService-Dev/1.0',
    });
    const { client: secretsClient } = fakeSecretsClient(
      JSON.stringify({ clientId: 'id', clientSecret: 'secret' }),
    );

    await expect(readNerisConfig(DEV_ENV, { ssmClient, secretsClient })).rejects.toThrow(
      /NERIS production host|refusing to start/i,
    );
  });

  it('in production Boxalarm (STAGE=prod), allows the NERIS production host', async () => {
    const { readNerisConfig } = await import('./config.js');
    const { client: ssmClient } = fakeSsmClient({
      '/boxalarm/prod/neris/base-url': 'https://api.neris.fsri.org/v1',
      '/boxalarm/prod/neris/user-agent': 'BoxalarmIncidentService-Prod/1.0',
    });
    const { client: secretsClient } = fakeSecretsClient(
      JSON.stringify({ clientId: 'prod-id', clientSecret: 'prod-secret' }),
    );

    const config = await readNerisConfig(PROD_ENV, { ssmClient, secretsClient });
    expect(config.baseUrl).toBe('https://api.neris.fsri.org/v1');
    expect(config.userAgent).toBe('BoxalarmIncidentService-Prod/1.0');
    expect(config.clientId).toBe('prod-id');
  });

  it('in production Boxalarm via BOXALARM_ENV, allows the NERIS production host', async () => {
    const { readNerisConfig } = await import('./config.js');
    const env: NodeJS.ProcessEnv = {
      BOXALARM_ENV: 'production',
      NERIS_BASE_URL_PARAM: '/boxalarm/prod/neris/base-url',
      NERIS_USER_AGENT_PARAM: '/boxalarm/prod/neris/user-agent',
      NERIS_CREDENTIALS_SECRET_ID: 'boxalarm/prod/neris/credentials',
    };
    const { client: ssmClient } = fakeSsmClient({
      '/boxalarm/prod/neris/base-url': 'https://api.neris.fsri.org/v1',
      '/boxalarm/prod/neris/user-agent': 'BoxalarmIncidentService-Prod/1.0',
    });
    const { client: secretsClient } = fakeSecretsClient(
      JSON.stringify({ clientId: 'prod-id', clientSecret: 'prod-secret' }),
    );

    await expect(readNerisConfig(env, { ssmClient, secretsClient })).resolves.toMatchObject({
      baseUrl: 'https://api.neris.fsri.org/v1',
    });
  });

  it('throws when the credentials secret has no SecretString', async () => {
    const { readNerisConfig } = await import('./config.js');
    const { client: ssmClient } = fakeSsmClient({
      '/boxalarm/dev/neris/base-url': 'https://api-test.neris.fsri.org/v1',
      '/boxalarm/dev/neris/user-agent': 'BoxalarmIncidentService-Dev/1.0',
    });
    const { client: secretsClient } = fakeSecretsClient(undefined);

    await expect(readNerisConfig(DEV_ENV, { ssmClient, secretsClient })).rejects.toThrow(
      'Secret boxalarm/dev/neris/credentials has no SecretString value',
    );
  });

  it('throws when credentials JSON is missing clientId or clientSecret', async () => {
    const { readNerisConfig } = await import('./config.js');
    const { client: ssmClient } = fakeSsmClient({
      '/boxalarm/dev/neris/base-url': 'https://api-test.neris.fsri.org/v1',
      '/boxalarm/dev/neris/user-agent': 'BoxalarmIncidentService-Dev/1.0',
    });
    const { client: secretsClient } = fakeSecretsClient(JSON.stringify({ clientId: 'only-id' }));

    await expect(readNerisConfig(DEV_ENV, { ssmClient, secretsClient })).rejects.toThrow(
      /clientId|clientSecret/i,
    );
  });

  it('in non-prod Boxalarm, uses NERIS_PRODUCTION_HOST from env for the fail-closed check when set', async () => {
    const { readNerisConfig } = await import('./config.js');
    const env: NodeJS.ProcessEnv = {
      ...DEV_ENV,
      NERIS_PRODUCTION_HOST: 'api-test.neris.fsri.org',
    };
    const { client: ssmClient } = fakeSsmClient({
      '/boxalarm/dev/neris/base-url': 'https://api-test.neris.fsri.org/v1',
      '/boxalarm/dev/neris/user-agent': 'BoxalarmIncidentService-Dev/1.0',
    });
    const { client: secretsClient } = fakeSecretsClient(
      JSON.stringify({ clientId: 'id', clientSecret: 'secret' }),
    );

    await expect(readNerisConfig(env, { ssmClient, secretsClient })).rejects.toThrow(
      /NERIS production host|refusing to start/i,
    );
  });
});

describe('readNerisConfig caching', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('caches the resolved config so a second call does not re-hit SSM or Secrets Manager', async () => {
    const { readNerisConfig } = await import('./config.js');
    const { client: ssmClient, send: ssmSend } = fakeSsmClient({
      '/boxalarm/dev/neris/base-url': 'https://api-test.neris.fsri.org/v1',
      '/boxalarm/dev/neris/user-agent': 'BoxalarmIncidentService-Dev/1.0',
    });
    const { client: secretsClient, send: secretsSend } = fakeSecretsClient(
      JSON.stringify({ clientId: 'dev-client-id', clientSecret: 'dev-client-secret' }),
    );

    const first = await readNerisConfig(DEV_ENV, { ssmClient, secretsClient });
    const second = await readNerisConfig(DEV_ENV, { ssmClient, secretsClient });

    expect(second).toEqual(first);
    // Two SSM params (base URL, User-Agent) fetched once total, not once per call.
    expect(ssmSend).toHaveBeenCalledTimes(2);
    expect(secretsSend).toHaveBeenCalledTimes(1);
  });

  it('ignores different deps on a second call once a config is already cached (matches the client-caching pattern)', async () => {
    const { readNerisConfig } = await import('./config.js');
    const { client: ssmClient } = fakeSsmClient({
      '/boxalarm/dev/neris/base-url': 'https://api-test.neris.fsri.org/v1',
      '/boxalarm/dev/neris/user-agent': 'BoxalarmIncidentService-Dev/1.0',
    });
    const { client: secretsClient } = fakeSecretsClient(
      JSON.stringify({ clientId: 'dev-client-id', clientSecret: 'dev-client-secret' }),
    );

    const first = await readNerisConfig(DEV_ENV, { ssmClient, secretsClient });

    const brokenSsmClient = { send: vi.fn().mockRejectedValue(new Error('should not be called')) };
    const second = await readNerisConfig(DEV_ENV, {
      ssmClient: brokenSsmClient as unknown as SSMClient,
      secretsClient,
    });

    expect(second).toEqual(first);
  });

  it('coalesces concurrent config loads into a single SSM/Secrets Manager round trip', async () => {
    const { readNerisConfig } = await import('./config.js');
    const { client: ssmClient, send: ssmSend } = fakeSsmClient({
      '/boxalarm/dev/neris/base-url': 'https://api-test.neris.fsri.org/v1',
      '/boxalarm/dev/neris/user-agent': 'BoxalarmIncidentService-Dev/1.0',
    });
    const { client: secretsClient, send: secretsSend } = fakeSecretsClient(
      JSON.stringify({ clientId: 'dev-client-id', clientSecret: 'dev-client-secret' }),
    );

    const [a, b] = await Promise.all([
      readNerisConfig(DEV_ENV, { ssmClient, secretsClient }),
      readNerisConfig(DEV_ENV, { ssmClient, secretsClient }),
    ]);

    expect(a).toEqual(b);
    expect(ssmSend).toHaveBeenCalledTimes(2);
    expect(secretsSend).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed config load, so a later call retries', async () => {
    const { readNerisConfig } = await import('./config.js');
    // Same underlying SSM client instance throughout (module-scope client
    // caching — a separate, already-covered concern — is not what's under
    // test here); its first two GetParameter calls fail transiently, then
    // it starts returning values, simulating a retry after a blip.
    const values: Record<string, string> = {
      '/boxalarm/dev/neris/base-url': 'https://api-test.neris.fsri.org/v1',
      '/boxalarm/dev/neris/user-agent': 'BoxalarmIncidentService-Dev/1.0',
    };
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('SSM transiently unavailable'))
      .mockRejectedValueOnce(new Error('SSM transiently unavailable'))
      .mockImplementation((command: { input: { Name: string } }) => {
        const name = command.input.Name;
        return Promise.resolve({ Parameter: { Name: name, Value: values[name] } });
      });
    const ssmClient = { send } as unknown as SSMClient;
    const { client: secretsClient } = fakeSecretsClient(
      JSON.stringify({ clientId: 'dev-client-id', clientSecret: 'dev-client-secret' }),
    );

    await expect(readNerisConfig(DEV_ENV, { ssmClient, secretsClient })).rejects.toThrow();

    await expect(readNerisConfig(DEV_ENV, { ssmClient, secretsClient })).resolves.toMatchObject({
      baseUrl: 'https://api-test.neris.fsri.org/v1',
    });
  });
});
