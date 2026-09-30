import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/**
 * The required webhook tests of docs/decisions/2026-09-29-cad-ingress-auth.md, against the
 * real handler with an in-memory table (conditional puts emulated) and a fake secret.
 */

const CURRENT = 'c'.repeat(64);
const PREVIOUS = 'p'.repeat(64);
const KEY_ID = 'nichols-fd.county';
const NOW = 1_800_000_000;

const COPY = {
  pk: 'DEPT#nichols-fd#CAD_INGRESS',
  sk: 'METADATA',
  sources: [
    {
      sourceId: 'county',
      label: 'County CAD',
      enabled: true,
      webhook: { keyId: KEY_ID, secretName: 'boxalarm-dev-cad-webhook-nichols-fd-county' },
      parser: {
        version: 1,
        fields: { address: { label: 'ADDR' }, incidentNumber: { label: 'INC' } },
      },
    },
    {
      sourceId: 'off',
      label: 'Disabled',
      enabled: false,
      webhook: { keyId: 'nichols-fd.off', secretName: 'boxalarm-dev-cad-webhook-nichols-fd-off' },
    },
  ],
};

interface Table {
  items: Map<string, Record<string, unknown>>;
  failTransact?: boolean;
}

function fakeDynamo(table: Table): DynamoDBDocumentClient {
  const keyOf = (item: Record<string, unknown>) => `${String(item.pk)}|${String(item.sk)}`;
  const send = vi.fn((command: { constructor: { name: string }; input: Record<string, never> }) => {
    const name = command.constructor.name;
    const input = command.input as Record<string, unknown>;
    if (name === 'GetCommand') {
      const key = input.Key as Record<string, unknown>;
      return Promise.resolve({ Item: table.items.get(keyOf(key)) });
    }
    if (name === 'PutCommand') {
      const item = input.Item as Record<string, unknown>;
      if (table.items.has(keyOf(item))) {
        return Promise.reject(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
      }
      table.items.set(keyOf(item), item);
      return Promise.resolve({});
    }
    if (name === 'DeleteCommand') {
      table.items.delete(keyOf(input.Key as Record<string, unknown>));
      return Promise.resolve({});
    }
    if (name === 'TransactWriteCommand') {
      if (table.failTransact) return Promise.reject(new Error('dynamo down'));
      const puts = (input.TransactItems as { Put: { Item: Record<string, unknown> } }[]).map(
        (entry) => entry.Put.Item,
      );
      if (table.items.has(keyOf(puts[0]!))) {
        return Promise.reject(
          new TransactionCanceledException({
            message: 'x',
            $metadata: {},
            CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
          }),
        );
      }
      for (const item of puts) table.items.set(keyOf(item), item);
      return Promise.resolve({});
    }
    return Promise.reject(new Error(`unexpected ${name}`));
  });
  return { send } as unknown as DynamoDBDocumentClient;
}

function sign(key: string, timestamp: string, body: string | Buffer): string {
  return createHmac('sha256', key).update(`${timestamp}.`).update(body).digest('hex');
}

function webhookEvent(
  body: string,
  options: {
    key?: string;
    timestamp?: number;
    keyId?: string;
    signature?: string;
    base64?: boolean;
  } = {},
): APIGatewayProxyEventV2 {
  const timestamp = String(options.timestamp ?? NOW);
  const signature = options.signature ?? `v1=${sign(options.key ?? CURRENT, timestamp, body)}`;
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/alerting/ingress/cad-webhook',
    rawPath: '/api/v1/alerting/ingress/cad-webhook',
    headers: {
      'x-boxalarm-source': options.keyId ?? KEY_ID,
      'x-boxalarm-timestamp': timestamp,
      'x-boxalarm-signature': signature,
    },
    isBase64Encoded: options.base64 === true,
    body: options.base64 ? Buffer.from(body).toString('base64') : body,
    requestContext: { requestId: 'req-1' },
  } as unknown as APIGatewayProxyEventV2;
}

const DISPATCH = JSON.stringify({ text: 'INC: 2026-1\nADDR: 123 MAIN ST, NICHOLS' });

describe('CAD webhook handler', () => {
  const originalEnv = { ...process.env };
  let table: Table;
  let secretSend: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
    process.env.ALERTING_TABLE_NAME = 'alerting';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    table = { items: new Map([[`${COPY.pk}|${COPY.sk}`, COPY]]) };
    secretSend = vi.fn().mockResolvedValue({
      SecretString: JSON.stringify({ current: CURRENT, previous: PREVIOUS }),
    });
    const dynamo = fakeDynamo(table);
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../eligibility/dynamoClient.js')>()),
      createDynamoClient: () => dynamo,
    }));
    const keys = await import('./webhookKeys.js');
    keys.resetWebhookKeyCache({ send: secretSend } as unknown as SecretsManagerClient);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function call(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
    const { handler } = await import('./webhookHandler.js');
    return (await handler(
      event,
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;
  }

  function alerts() {
    return [...table.items.values()].filter((item) => item.entityType === 'DISPATCH_ALERT');
  }

  function metric(name: string, reason?: string): boolean {
    return vi
      .mocked(console.log)
      .mock.calls.some(
        ([line]) =>
          String(line).includes(`"Name":"${name}"`) &&
          (reason === undefined || String(line).includes(`"Reason":"${reason}"`)),
      );
  }

  it('accepts a correctly signed request and writes one CAD dispatch (202)', async () => {
    const response = await call(webhookEvent(DISPATCH));
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body ?? '{}')).toMatchObject({
      status: 'accepted',
      parse: 'PARSED',
    });
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({
      deptId: 'nichols-fd',
      sourceSystem: 'CAD',
      ingressChannel: 'cad-webhook',
      address: '123 MAIN ST, NICHOLS',
    });
    expect(metric('CadIngressAccepted')).toBe(true);
    expect((secretSend.mock.calls[0]?.[0] as { input: unknown }).input).toEqual({
      SecretId: 'boxalarm-dev-cad-webhook-nichols-fd-county',
    });
  });

  it('a webhook signed with the wrong key does not page (401, generic body)', async () => {
    const response = await call(webhookEvent(DISPATCH, { key: 'w'.repeat(64) }));
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toMatch(/signature|timestamp|source/i);
    expect(alerts()).toHaveLength(0);
    expect(metric('CadIngressAuthFailed', 'BadSignature')).toBe(true);
  });

  it('a stale timestamp (301 s) does not page, and is checked before the signature', async () => {
    const response = await call(webhookEvent(DISPATCH, { timestamp: NOW - 301 }));
    expect(response.statusCode).toBe(401);
    expect(alerts()).toHaveLength(0);
    expect(metric('CadIngressAuthFailed', 'StaleTimestamp')).toBe(true);
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('a timestamp 300 s old or ahead is still inside the window', async () => {
    expect((await call(webhookEvent(DISPATCH, { timestamp: NOW - 300 }))).statusCode).toBe(202);
    const other = JSON.stringify({ text: 'INC: 2026-2\nADDR: 9 OAK AVE' });
    expect((await call(webhookEvent(other, { timestamp: NOW + 300 }))).statusCode).toBe(202);
  });

  it('an identical request replayed inside the window does not page (409)', async () => {
    expect((await call(webhookEvent(DISPATCH))).statusCode).toBe(202);
    const replay = await call(webhookEvent(DISPATCH));
    expect(replay.statusCode).toBe(409);
    expect(alerts()).toHaveLength(1);
    expect(metric('CadIngressReplayRejected')).toBe(true);
    const marker = [...table.items.values()].find((i) => i.entityType === 'CAD_REPLAY_MARKER');
    expect(marker).toMatchObject({ ttl: NOW + 900 });
    expect(String(marker?.pk)).toMatch(/^DEPT#nichols-fd#CAD_REPLAY#county#[0-9a-f]{64}$/);
  });

  it('rotation: a request signed with the previous key still passes', async () => {
    expect((await call(webhookEvent(DISPATCH, { key: PREVIOUS }))).statusCode).toBe(202);
  });

  it('accepts when any listed v1 signature matches', async () => {
    const good = sign(CURRENT, String(NOW), DISPATCH);
    const signature = `v1=${'0'.repeat(64)}, v1=${good}`;
    expect((await call(webhookEvent(DISPATCH, { signature }))).statusCode).toBe(202);
  });

  it('a body re-serialized after signing fails the signature', async () => {
    const timestamp = String(NOW);
    const signed = '{"text": "INC: 2026-1\\nADDR: 123 MAIN ST"}';
    const reserialized = JSON.stringify(JSON.parse(signed));
    expect(reserialized).not.toBe(signed);
    const event = webhookEvent(reserialized, {
      signature: `v1=${sign(CURRENT, timestamp, signed)}`,
    });
    expect((await call(event)).statusCode).toBe(401);
    expect(alerts()).toHaveLength(0);
  });

  it('computes the signature over the base64-decoded raw bytes', async () => {
    expect((await call(webhookEvent(DISPATCH, { base64: true }))).statusCode).toBe(202);
  });

  it('a body naming another deptId pages only the configured department', async () => {
    const body = JSON.stringify({ deptId: 'other-fd', address: '5 ELM ST', incidentNumber: 'X1' });
    expect((await call(webhookEvent(body))).statusCode).toBe(202);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]?.deptId).toBe('nichols-fd');
    expect(String(alerts()[0]?.pk)).toMatch(/^DEPT#nichols-fd#DISPATCH#/);
  });

  it('an authenticated but unparseable message pages with the raw text, flagged VERIFY', async () => {
    const response = await call(webhookEvent('SMOKE REPORTED NEAR THE OLD MILL'));
    expect(JSON.parse(response.body ?? '{}')).toMatchObject({ parse: 'RAW' });
    expect(alerts()[0]).toMatchObject({
      address: 'SEE DISPATCH TEXT',
      narrative: 'SMOKE REPORTED NEAR THE OLD MILL',
      verifyRequired: true,
    });
  });

  it('an idempotent resend (new signature, same incident) answers 200 duplicate and does not page', async () => {
    expect((await call(webhookEvent(DISPATCH))).statusCode).toBe(202);
    const resend = await call(webhookEvent(DISPATCH, { timestamp: NOW + 5 }));
    expect(resend.statusCode).toBe(200);
    expect(JSON.parse(resend.body ?? '{}')).toEqual({ status: 'duplicate' });
    expect(alerts()).toHaveLength(1);
  });

  it.each([
    ['an unknown source', { keyId: 'nichols-fd.nope' }],
    ['a disabled source', { keyId: 'nichols-fd.off' }],
    ['a malformed source header', { keyId: 'not a key' }],
    ['another department claiming the source', { keyId: 'other-fd.county' }],
  ])('%s is 401 and never reads a secret', async (_name, options) => {
    const response = await call(webhookEvent(DISPATCH, options));
    expect(response.statusCode).toBe(401);
    expect(secretSend).not.toHaveBeenCalled();
    expect(alerts()).toHaveLength(0);
  });

  it('refuses a body over 64 KiB before anything else (413)', async () => {
    const response = await call(webhookEvent('x'.repeat(64 * 1024 + 1)));
    expect(response.statusCode).toBe(413);
    expect(metric('CadIngressRejected', 'BodyTooLarge')).toBe(true);
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('fails closed with 503 (CAD retries) when the secret cannot be read', async () => {
    secretSend.mockRejectedValue(new Error('throttled'));
    const response = await call(webhookEvent(DISPATCH));
    expect(response.statusCode).toBe(503);
    expect(alerts()).toHaveLength(0);
  });

  it('a secret with no usable key is 401 (NoActiveKey)', async () => {
    secretSend.mockResolvedValue({ SecretString: '{"current":"short"}' });
    expect((await call(webhookEvent(DISPATCH))).statusCode).toBe(401);
    expect(metric('CadIngressAuthFailed', 'NoActiveKey')).toBe(true);
  });

  it('releases the replay marker when the dispatch write fails, so the retry is not a replay', async () => {
    table.failTransact = true;
    expect((await call(webhookEvent(DISPATCH))).statusCode).toBe(503);
    expect([...table.items.values()].some((i) => i.entityType === 'CAD_REPLAY_MARKER')).toBe(false);
    table.failTransact = false;
    expect((await call(webhookEvent(DISPATCH))).statusCode).toBe(202);
  });
});

describe('readWebhookBody', () => {
  it('ignores keys that are not CAD fields and joins a units array', async () => {
    const { readWebhookBody } = await import('./webhookHandler.js');
    expect(
      readWebhookBody(JSON.stringify({ address: '1 A ST', units: ['E1', 'L2'], deptId: 'x' })),
    ).toEqual({
      text: 'address: 1 A ST\nunits: E1, L2',
      structured: { address: '1 A ST', units: 'E1, L2' },
    });
  });
});
