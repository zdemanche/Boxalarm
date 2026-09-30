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
process.env.CAD_WEBHOOK_SECRET_PREFIX = 'boxalarm-dev-cad-webhook-';

import { Decision } from '@aws-sdk/client-verifiedpermissions';
import {
  ResourceNotFoundException,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { handler } from './handler.js';
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
  beforeEach(() => {
    setSecretsClient({ send: smSend } as unknown as SecretsManagerClient);
    smSend.mockReset();
  });

  async function saveSource() {
    await handler(event('PUT /api/v1/platform/cad-sources', { sources: [SOURCE] }));
    ddbSend.mockClear();
    vpSend.mockClear();
  }

  it('creates the secret on first rotation and returns the key once, no-store', async () => {
    await saveSource();
    smSend.mockImplementation((command: Command) =>
      command.constructor.name === 'CreateSecretCommand'
        ? Promise.resolve({})
        : Promise.reject(new ResourceNotFoundException({ message: 'no', $metadata: {} })),
    );
    const response = (await rotateHandler(
      event('POST /api/v1/platform/cad-sources/{sourceId}/webhook-key', undefined, {
        sourceId: 'county',
      }),
    )) as { statusCode: number; body: string; headers: Record<string, string> };
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(response.body) as { keyId: string; secret: string };
    expect(body.keyId).toBe('nichols-fd.county');
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(cedarAction()).toBe('ManageCadIngress');
    const create = smSend.mock.calls.find(
      ([c]) => (c as Command).constructor.name === 'CreateSecretCommand',
    )?.[0] as Command;
    expect(create.input.Name).toBe('boxalarm-dev-cad-webhook-nichols-fd-county');
    expect(JSON.parse(String(create.input.SecretString))).toEqual({ current: body.secret });
    // The config now points the alerting plane at the secret.
    const [config] = transactItems();
    expect(JSON.stringify(config)).toContain('"webhook":{"keyId":"nichols-fd.county"');
    // Never logged.
    const logged = vi
      .mocked(console.log)
      .mock.calls.map(([l]) => String(l))
      .join('\n');
    expect(logged).not.toContain(body.secret);
  });

  it('keeps the old key as previous so the CAD keeps working during rotation', async () => {
    await saveSource();
    const old = 'o'.repeat(64);
    smSend.mockImplementation((command: Command) =>
      Promise.resolve(
        command.constructor.name === 'GetSecretValueCommand'
          ? { SecretString: JSON.stringify({ current: old }) }
          : {},
      ),
    );
    const response = (await rotateHandler(event('POST /x', undefined, { sourceId: 'county' }))) as {
      body: string;
    };
    const put = smSend.mock.calls.find(
      ([c]) => (c as Command).constructor.name === 'PutSecretValueCommand',
    )?.[0] as Command;
    expect(JSON.parse(String(put.input.SecretString))).toEqual({
      current: (JSON.parse(response.body) as { secret: string }).secret,
      previous: old,
    });
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
