import { beforeEach, describe, expect, it, vi } from 'vitest';

const { vpSend, ddbSend, smSend } = vi.hoisted(() => ({
  vpSend: vi.fn(),
  ddbSend: vi.fn(),
  smSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
  return {
    ...actual,
    VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({ send: vpSend })),
  };
});
vi.mock('../export/awsClients.js', () => ({ getDynamoDocClient: () => ({ send: ddbSend }) }));

process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
process.env.PLATFORM_TABLE_NAME = 'platform-table';
process.env.CAD_INGRESS_EMAIL_DOMAIN = 'ingress.example.org';
process.env.CAD_WEBHOOK_URL = 'https://cad.example.org/api/v1/alerting/ingress/cad-webhook';
process.env.CAD_WEBHOOK_SECRET_PREFIX = 'boxalarm-dev-cad-webhook/';

import { Decision } from '@aws-sdk/client-verifiedpermissions';
import {
  ResourceNotFoundException,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { handler, setSettingsSecretsClient } from './handler.js';
import { handler as rotateHandler, setSecretsClient } from './rotateKey.js';

interface Command {
  readonly constructor: { name: string };
  readonly input: Record<string, unknown>;
}

function event(routeKey: string, body?: unknown, pathParameters?: Record<string, string>) {
  return {
    routeKey,
    headers: { authorization: 'Bearer token' },
    body: body === undefined ? undefined : JSON.stringify(body),
    pathParameters,
    requestContext: {
      authorizer: { lambda: { sub: 'chief-1', deptId: 'nichols-fd', 'cognito:groups': 'CHIEF' } },
    },
  } as never;
}

const SOURCE = {
  sourceId: 'county',
  label: 'County CAD',
  enabled: true,
  emailEnabled: true,
  allowedSenders: ['cad.county.gov'],
  webhookEnabled: true,
  parser: { fields: { address: { label: 'ADDR' }, incidentNumber: { label: 'INC' } } },
};

let stored: Record<string, unknown> | undefined;

function transactItems(): Record<string, unknown>[] {
  const call = ddbSend.mock.calls.find(
    ([command]) => (command as Command).constructor.name === 'TransactWriteCommand',
  );
  return (
    (call?.[0] as Command).input.TransactItems as { Put: { Item: Record<string, unknown> } }[]
  ).map((entry) => entry.Put.Item);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  stored = undefined;
  vpSend.mockResolvedValue({ decision: Decision.ALLOW });
  ddbSend.mockImplementation((command: Command) => {
    if (command.constructor.name === 'GetCommand') return Promise.resolve({ Item: stored });
    if (command.constructor.name === 'TransactWriteCommand') {
      const item = (command.input.TransactItems as { Put: { Item: Record<string, unknown> } }[])[0]!
        .Put.Item;
      stored = item;
      return Promise.resolve({});
    }
    return Promise.reject(new Error(`unexpected ${command.constructor.name}`));
  });
});

function cedarAction(): string | undefined {
  const input = (vpSend.mock.calls[0]?.[0] as Command | undefined)?.input as
    { action?: { actionId?: string } } | undefined;
  return input?.action?.actionId;
}

describe('GET /platform/cad-sources', () => {
  it('returns an empty list before anything is saved (Cedar ViewCadIngress)', async () => {
    const response = (await handler(event('GET /api/v1/platform/cad-sources'))) as {
      statusCode: number;
      body: string;
    };
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      version: null,
      sources: [],
      emailDomain: 'ingress.example.org',
    });
    expect(cedarAction()).toBe('ViewCadIngress');
  });

  it('is 403 when Cedar denies', async () => {
    vpSend.mockResolvedValue({ decision: Decision.DENY });
    const response = (await handler(event('GET /api/v1/platform/cad-sources'))) as {
      statusCode: number;
    };
    expect(response.statusCode).toBe(403);
  });
});

describe('PUT /platform/cad-sources', () => {
  it('saves CAD_INGRESS with its platform.config.updated outbox row (Cedar ManageCadIngress)', async () => {
    const response = (await handler(
      event('PUT /api/v1/platform/cad-sources', { sources: [SOURCE] }),
    )) as { statusCode: number; body: string };
    expect(response.statusCode).toBe(200);
    expect(cedarAction()).toBe('ManageCadIngress');
    const [config, outbox] = transactItems();
    expect(config).toMatchObject({ pk: 'DEPT#nichols-fd', sk: 'CONFIG#CAD_INGRESS', version: 1 });
    expect(JSON.stringify(outbox)).toContain('platform.config.updated');
    expect(JSON.stringify(outbox)).toContain('"configType":"CAD_INGRESS"');
    const view = JSON.parse(response.body) as { sources: { emailAddress: string }[] };
    expect(view.sources[0]?.emailAddress).toMatch(
      /^dispatch\+nichols-fd\.county\.[a-z0-9]{16}@ingress\.example\.org$/,
    );
  });

  it('warns (does not block) when a source has no incident number rule', async () => {
    const bare = { ...SOURCE, parser: { fields: { address: { label: 'ADDR' } } } };
    const response = (await handler(
      event('PUT /api/v1/platform/cad-sources', { sources: [bare] }),
    )) as { statusCode: number; body: string };
    expect(response.statusCode).toBe(200);
    expect((JSON.parse(response.body) as { warnings: unknown }).warnings).toEqual([
      expect.objectContaining({ field: 'sources[0].parser.fields.incidentNumber' }),
    ]);
  });

  it('refuses a blind overwrite of a saved config (409 without the loaded version)', async () => {
    stored = { value: { sources: [] }, version: 3 };
    const response = (await handler(
      event('PUT /api/v1/platform/cad-sources', { sources: [SOURCE] }),
    )) as { statusCode: number };
    expect(response.statusCode).toBe(409);
  });

  it('removing a keyed source deletes its webhook secret at once (security review M5)', async () => {
    const del = vi.fn().mockResolvedValue({});
    setSettingsSecretsClient({ send: del } as unknown as SecretsManagerClient);
    stored = {
      version: 2,
      value: {
        sources: [
          {
            sourceId: 'county',
            label: 'County',
            enabled: true,
            webhookEnabled: true,
            webhookKey: {
              keyId: 'nichols-fd.county',
              secretName: 'boxalarm-dev-cad-webhook/nichols-fd/county',
              rotatedAt: 'x',
            },
          },
        ],
      },
    };
    const response = (await handler(
      event('PUT /api/v1/platform/cad-sources', { sources: [], expectedVersion: 2 }),
    )) as { statusCode: number };
    expect(response.statusCode).toBe(200);
    expect((del.mock.calls[0]?.[0] as Command).input).toEqual({
      SecretId: 'boxalarm-dev-cad-webhook/nichols-fd/county',
      ForceDeleteWithoutRecovery: true,
    });
  });

  it('is 400 with field errors for an invalid template', async () => {
    const bad = { ...SOURCE, parser: { fields: { address: { pattern: '(a+)+' } } } };
    const response = (await handler(
      event('PUT /api/v1/platform/cad-sources', { sources: [bad] }),
    )) as { statusCode: number; body: string };
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('sources[0].parser.fields.address.pattern');
  });
});

describe('POST /platform/cad-sources/test-parse', () => {
  it('previews a PARSED result', async () => {
    const response = (await handler(
      event('POST /api/v1/platform/cad-sources/test-parse', {
        fields: SOURCE.parser.fields,
        sample: 'INC: 7\nADDR: 1 MAIN ST',
      }),
    )) as { statusCode: number; body: string };
    expect(JSON.parse(response.body)).toEqual({
      status: 'PARSED',
      fields: { address: '1 MAIN ST', incidentNumber: '7' },
    });
  });

  it('a catastrophic pattern previews as RAW (TIMEOUT) instead of hanging the route', async () => {
    const response = (await handler(
      event('POST /api/v1/platform/cad-sources/test-parse', {
        fields: { address: { pattern: '((a)+)+$' } },
        sample: `${'a'.repeat(40)}!`,
      }),
    )) as { body: string };
    expect(JSON.parse(response.body)).toMatchObject({ status: 'RAW', reason: 'TIMEOUT' });
  }, 10_000);

  it('previews the fail-open RAW result', async () => {
    const response = (await handler(
      event('POST /api/v1/platform/cad-sources/test-parse', {
        fields: SOURCE.parser.fields,
        sample: 'nothing structured',
      }),
    )) as { body: string };
    expect(JSON.parse(response.body)).toMatchObject({ status: 'RAW', reason: 'NO_ADDRESS' });
  });
});

describe('POST /platform/cad-sources/{sourceId}/webhook-key', () => {
  // A stateful fake secret store: Get returns what Create/Put last wrote.
  let secretStore: Map<string, string>;
  beforeEach(() => {
    secretStore = new Map();
    setSecretsClient({ send: smSend } as unknown as SecretsManagerClient);
    smSend.mockReset();
    smSend.mockImplementation((command: Command) => {
      const input = command.input;
      switch (command.constructor.name) {
        case 'GetSecretValueCommand': {
          const value = secretStore.get(String(input.SecretId));
          return value === undefined
            ? Promise.reject(new ResourceNotFoundException({ message: 'no', $metadata: {} }))
            : Promise.resolve({ SecretString: value });
        }
        case 'CreateSecretCommand':
          secretStore.set(String(input.Name), String(input.SecretString));
          return Promise.resolve({});
        case 'PutSecretValueCommand':
          secretStore.set(String(input.SecretId), String(input.SecretString));
          return Promise.resolve({});
        default:
          return Promise.reject(new Error(command.constructor.name));
      }
    });
  });

  const NAME = 'boxalarm-dev-cad-webhook/nichols-fd/county';
  const secretValue = () => JSON.parse(secretStore.get(NAME) ?? '{}') as Record<string, unknown>;

  async function saveSource() {
    await handler(event('PUT /api/v1/platform/cad-sources', { sources: [SOURCE] }));
    ddbSend.mockClear();
    vpSend.mockClear();
  }

  async function rotate() {
    return (await rotateHandler(
      event('POST /api/v1/platform/cad-sources/{sourceId}/webhook-key', undefined, {
        sourceId: 'county',
      }),
    )) as { statusCode: number; body: string; headers: Record<string, string> };
  }

  it('creates the secret on first rotation (tagged, owner recorded) and returns the key once, no-store', async () => {
    await saveSource();
    const response = await rotate();
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(response.body) as { keyId: string; secret: string };
    expect(body.keyId).toBe('nichols-fd.county');
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(cedarAction()).toBe('ManageCadIngress');
    const create = smSend.mock.calls.find(
      ([c]) => (c as Command).constructor.name === 'CreateSecretCommand',
    )?.[0] as Command;
    expect(create.input.Name).toBe(NAME);
    expect(create.input.Tags).toEqual(
      expect.arrayContaining([
        { Key: 'boxalarm:deptId', Value: 'nichols-fd' },
        { Key: 'boxalarm:sourceId', Value: 'county' },
      ]),
    );
    expect(secretValue()).toEqual({
      deptId: 'nichols-fd',
      sourceId: 'county',
      current: body.secret,
    });
    const [config] = transactItems();
    expect(JSON.stringify(config)).toContain('"webhook":{"keyId":"nichols-fd.county"');
    const logged = vi
      .mocked(console.log)
      .mock.calls.map(([l]) => String(l))
      .join('\n');
    expect(logged).not.toContain(body.secret);
  });

  it('keeps the old key as previous for 24 h only (security review M5)', async () => {
    await saveSource();
    const first = JSON.parse((await rotate()).body) as { secret: string };
    const before = Math.floor(Date.now() / 1000);
    const second = JSON.parse((await rotate()).body) as {
      secret: string;
      previousKeyExpiresAt: string;
    };
    const value = secretValue();
    expect(value).toMatchObject({ current: second.secret, previous: first.secret });
    expect(Number(value.previousExpiresAt) - before).toBeGreaterThanOrEqual(24 * 3600 - 1);
    expect(Number(value.previousExpiresAt) - before).toBeLessThanOrEqual(24 * 3600 + 5);
    expect(Date.parse(second.previousKeyExpiresAt) / 1000).toBe(value.previousExpiresAt);
  });

  it('revoke-previous removes the previous key now and keeps the current one', async () => {
    await saveSource();
    await rotate();
    const current = JSON.parse((await rotate()).body) as { secret: string };
    const response = (await rotateHandler(
      event('POST /api/v1/platform/cad-sources/{sourceId}/webhook-key/revoke-previous', undefined, {
        sourceId: 'county',
      }),
    )) as { statusCode: number };
    expect(response.statusCode).toBe(200);
    expect(secretValue()).toEqual({
      deptId: 'nichols-fd',
      sourceId: 'county',
      current: current.secret,
    });
  });

  it('a concurrent rotation that did not win is refused (409), never handing out a dead key', async () => {
    await saveSource();
    const original = smSend.getMockImplementation() as (command: Command) => Promise<unknown>;
    let puts = 0;
    smSend.mockImplementation((command: Command) => {
      // Another rotation's write lands right after ours.
      if (command.constructor.name === 'CreateSecretCommand' && puts++ === 0) {
        return original(command).then(() => {
          secretStore.set(
            NAME,
            JSON.stringify({ deptId: 'nichols-fd', sourceId: 'county', current: 'z'.repeat(64) }),
          );
          return {};
        });
      }
      return original(command);
    });
    expect((await rotate()).statusCode).toBe(409);
  });

  it('secret names cannot collide across departments (security review M1)', async () => {
    const { cadWebhookSecretName } = await import('./rotateKey.js');
    const a = cadWebhookSecretName('p/', 'nichols', 'fd-county');
    const b = cadWebhookSecretName('p/', 'nichols-fd', 'county');
    expect(a).not.toBe(b);
    expect(() => cadWebhookSecretName('p/', 'a/b', 'c')).toThrow();
  });

  it('refuses to rotate a secret whose value names another owner (409), writing nothing', async () => {
    await saveSource();
    secretStore.set(
      NAME,
      JSON.stringify({ deptId: 'nichols', sourceId: 'fd-county', current: 'x'.repeat(64) }),
    );
    expect((await rotate()).statusCode).toBe(409);
    expect(
      smSend.mock.calls.some(([c]) => (c as Command).constructor.name === 'PutSecretValueCommand'),
    ).toBe(false);
  });

  it('is 404 for a source that has not been saved', async () => {
    const response = (await rotateHandler(event('POST /x', undefined, { sourceId: 'nope' }))) as {
      statusCode: number;
    };
    expect(response.statusCode).toBe(404);
    expect(smSend).not.toHaveBeenCalled();
  });
});

describe('the generic config route', () => {
  it('cannot write CAD_INGRESS (server-managed fields; this route and its Cedar actions only)', async () => {
    const { isDepartmentConfigType } = await import('../config/repository.js');
    expect(isDepartmentConfigType('CAD_INGRESS')).toBe(false);
  });
});
