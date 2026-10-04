import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuardEvent, WithAuthorizationOptions } from '@boxalarm/authz';
import { createHandler } from './handler.js';

// @boxalarm/authz caches the first client it is handed, so every test shares this one.
const authzSend = vi.fn();
const authzClient = { send: authzSend } as unknown as NonNullable<
  WithAuthorizationOptions['client']
>;

function event(itemId: string | undefined, body: unknown): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/inventory/consumables/{itemId}',
    rawPath: `/api/v1/inventory/consumables/${itemId ?? ''}`,
    rawQueryString: '',
    headers: { authorization: 'Bearer test-token' },
    pathParameters: itemId ? { itemId } : undefined,
    requestContext: {
      requestId: 'req-1',
      authorizer: { lambda: { sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': 'ADMIN' } },
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  } as unknown as GuardEvent;
}

function fakeDocClient(send: (command: unknown) => unknown) {
  const sendMock = vi.fn((command: unknown) => Promise.resolve(send(command)));
  return Object.assign({ send: sendMock } as unknown as DynamoDBDocumentClient, { sendMock });
}

type Result = { statusCode: number; body?: string };

async function invoke(evt: GuardEvent, client: DynamoDBDocumentClient): Promise<Result> {
  return (await createHandler({ authzClient, dynamoClient: client })(evt)) as Result;
}

describe('handler (PUT /api/v1/inventory/consumables/{itemId})', () => {
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

  it('AC1: updates stockLevel and returns the updated consumable (entrypoint-test)', async () => {
    const client = fakeDocClient((command) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === 'UpdateCommand') {
        return {
          Attributes: {
            pk: 'DEPT#NICHOLS#CONSUMABLE#gloves-m',
            sk: 'METADATA',
            entityType: 'CONSUMABLE_STOCK',
            itemName: 'Gloves (M)',
            stockLevel: 40,
            reorderThreshold: 10,
          },
        };
      }
      return {};
    });
    const result = await invoke(event('gloves-m', { stockLevel: 40 }), client);
    expect(result.statusCode).toBe(200);
    const consumable = JSON.parse(result.body ?? '{}') as Record<string, unknown>;
    expect(consumable.itemId).toBe('gloves-m');
    expect(consumable.stockLevel).toBe(40);
    expect(consumable.reorderThreshold).toBe(10);
  });

  it('AC2: writes an AUDIT_LOG_ENTRY for the restock', async () => {
    const client = fakeDocClient((command) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === 'UpdateCommand') {
        return {
          Attributes: {
            pk: 'DEPT#NICHOLS#CONSUMABLE#gloves-m',
            sk: 'METADATA',
            entityType: 'CONSUMABLE_STOCK',
            itemName: 'Gloves (M)',
            stockLevel: 40,
            reorderThreshold: 10,
          },
        };
      }
      return {};
    });
    await invoke(event('gloves-m', { stockLevel: 40 }), client);
    const putCalls = client.sendMock.mock.calls.filter(
      ([command]: [{ constructor: { name: string } }]) => command.constructor.name === 'PutCommand',
    );
    expect(putCalls).toHaveLength(1);
    const input = (putCalls[0]![0] as { input: { Item: Record<string, unknown> } }).input;
    expect(input.Item.entityType).toBe('AUDIT_LOG_ENTRY');
    expect(input.Item.mutatedEntityType).toBe('CONSUMABLE_STOCK');
    expect(input.Item.mutatedEntityId).toBe('gloves-m');
  });

  it('asks Verified Permissions for RestockConsumable on the path item', async () => {
    await invoke(
      event('gloves-m', { stockLevel: 40 }),
      fakeDocClient(() => ({
        Attributes: {
          pk: 'DEPT#NICHOLS#CONSUMABLE#gloves-m',
          itemName: 'Gloves (M)',
          stockLevel: 40,
          reorderThreshold: 10,
        },
      })),
    );
    const input = (authzSend.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(input.action).toEqual({
      actionType: 'Boxalarm::Action',
      actionId: 'RestockConsumable',
    });
    expect(input.resource).toEqual({ entityType: 'Boxalarm::Asset', entityId: 'gloves-m' });
  });

  it('403 and no write when Cedar denies (caller lacks chief/admin/officer)', async () => {
    authzSend.mockResolvedValue({ decision: 'DENY' });
    const client = fakeDocClient(() => ({}));
    const result = await invoke(event('gloves-m', { stockLevel: 40 }), client);
    expect(result.statusCode).toBe(403);
    expect(client.sendMock).not.toHaveBeenCalled();
  });

  it('400 problem+json when neither stockLevel nor reorderThreshold is present', async () => {
    const result = await invoke(
      event('gloves-m', {}),
      fakeDocClient(() => ({})),
    );
    expect(result.statusCode).toBe(400);
  });

  it('400 problem+json when stockLevel is negative', async () => {
    const result = await invoke(
      event('gloves-m', { stockLevel: -1 }),
      fakeDocClient(() => ({})),
    );
    expect(result.statusCode).toBe(400);
  });

  it('404 problem+json when itemId is not found', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakeDocClient(() => {
      throw new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} });
    });
    const result = await invoke(event('missing', { stockLevel: 40 }), client);
    expect(result.statusCode).toBe(404);
  });
});
