import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuardEvent, WithAuthorizationOptions } from '@boxalarm/authz';
import { createHandler } from './handler.js';

const authzSend = vi.fn();
const authzClient = { send: authzSend } as unknown as NonNullable<
  WithAuthorizationOptions['client']
>;

function event(body: unknown): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/inventory/consumables',
    rawPath: '/api/v1/inventory/consumables',
    rawQueryString: '',
    headers: { authorization: 'Bearer test-token' },
    requestContext: {
      requestId: 'req-1',
      authorizer: { lambda: { sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': 'ADMIN' } },
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  } as unknown as GuardEvent;
}

function fakeDocClient() {
  const send = vi.fn(() => Promise.resolve({}));
  return Object.assign({ send } as unknown as DynamoDBDocumentClient, { sendMock: send });
}

type Result = { statusCode: number; body?: string };

async function invoke(evt: GuardEvent, client: DynamoDBDocumentClient): Promise<Result> {
  return (await createHandler({ authzClient, dynamoClient: client })(evt)) as Result;
}

describe('handler (POST /api/v1/inventory/consumables)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    authzSend.mockReset();
    process.env.PLATFORM_TABLE_NAME = 'boxalarm-platform';
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    authzSend.mockResolvedValue({ decision: 'ALLOW' });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('creates a consumable and returns 201 with the item (entrypoint-test)', async () => {
    const client = fakeDocClient();
    const result = await invoke(
      event({ itemName: 'Nitrile gloves', stockLevel: 40, reorderThreshold: 10 }),
      client,
    );
    expect(result.statusCode).toBe(201);
    expect(JSON.parse(result.body ?? '{}')).toMatchObject({
      itemName: 'Nitrile gloves',
      deptId: 'NICHOLS',
      stockLevel: 40,
    });
    expect(client.sendMock).toHaveBeenCalledTimes(1);
  });

  it('asks Verified Permissions for CreateConsumable on the department', async () => {
    await invoke(event({ itemName: 'x', stockLevel: 1, reorderThreshold: 1 }), fakeDocClient());
    const input = (authzSend.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(input.action).toEqual({ actionType: 'Boxalarm::Action', actionId: 'CreateConsumable' });
  });

  it.each([
    ['missing itemName', { stockLevel: 1, reorderThreshold: 1 }],
    ['negative stockLevel', { itemName: 'x', stockLevel: -1, reorderThreshold: 1 }],
    ['missing reorderThreshold', { itemName: 'x', stockLevel: 1 }],
    ['fractional stockLevel', { itemName: 'x', stockLevel: 1.5, reorderThreshold: 1 }],
    ['null body', null],
    ['array body', []],
    ['overlong itemName', { itemName: 'x'.repeat(201), stockLevel: 1, reorderThreshold: 1 }],
    [
      'overlong location',
      { itemName: 'x', stockLevel: 1, reorderThreshold: 1, location: 'x'.repeat(201) },
    ],
  ])('400 and no write on %s', async (_name, body) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakeDocClient();
    const result = await invoke(event(body), client);
    expect(result.statusCode).toBe(400);
    expect(client.sendMock).not.toHaveBeenCalled();
  });

  it('400 and no write on a malformed JSON body', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakeDocClient();
    const evt = { ...event({}), body: '{not json' } as GuardEvent;
    const result = await invoke(evt, client);
    expect(result.statusCode).toBe(400);
    expect(client.sendMock).not.toHaveBeenCalled();
  });

  it('403 and no write when Cedar denies', async () => {
    authzSend.mockResolvedValue({ decision: 'DENY' });
    const client = fakeDocClient();
    const result = await invoke(
      event({ itemName: 'x', stockLevel: 1, reorderThreshold: 1 }),
      client,
    );
    expect(result.statusCode).toBe(403);
    expect(client.sendMock).not.toHaveBeenCalled();
  });
});
