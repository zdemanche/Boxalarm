import { describe, expect, it, vi } from 'vitest';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  CompartmentItemInvalidKeyError,
  CompartmentItemNotFoundError,
  CompartmentItemStoreUnavailableError,
  listCompartmentItems,
  putCompartmentItem,
  updateCompartmentItemQuantity,
} from './compartmentItemRepository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-001' });
const TABLE_NAME = 'platform-service';
const ACTOR_ID = 'officer-1';

function fakeClient(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('listCompartmentItems', () => {
  it('queries begins_with(sk, COMPARTMENT_ITEM#) on the dept-scoped apparatus pk, consistent read, and maps records (AP#34, core-harm)', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          pk: 'DEPT#dept-001#APPARATUS#ENGINE-2',
          sk: 'COMPARTMENT_ITEM#CI-021',
          compartmentCode: 'C1',
          itemName: 'Halligan',
          quantity: 2,
        },
      ],
    });
    const client = fakeClient(send);

    const items = await listCompartmentItems(client, TABLE_NAME, DEPT_ID, 'ENGINE-2');

    expect(items).toEqual([
      { itemId: 'CI-021', compartmentCode: 'C1', itemName: 'Halligan', quantity: 2 },
    ]);
    const sentInput = (send.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(sentInput).toMatchObject({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pkValue AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pkValue': 'DEPT#dept-001#APPARATUS#ENGINE-2',
        ':skPrefix': 'COMPARTMENT_ITEM#',
      },
      ConsistentRead: true,
    });
  });

  it('returns an empty list for an apparatus with no compartment items', async () => {
    const client = fakeClient(vi.fn().mockResolvedValue({ Items: [] }));
    await expect(listCompartmentItems(client, TABLE_NAME, DEPT_ID, 'ENGINE-9')).resolves.toEqual(
      [],
    );
  });

  it('wraps a DynamoDB outage as CompartmentItemStoreUnavailableError, logging the original error first (fail-closed)', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cause = new Error('ProvisionedThroughputExceededException');
    const client = fakeClient(vi.fn().mockRejectedValue(cause));

    await expect(
      listCompartmentItems(client, TABLE_NAME, DEPT_ID, 'ENGINE-2'),
    ).rejects.toBeInstanceOf(CompartmentItemStoreUnavailableError);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('inventory.list.storeError'));
    logSpy.mockRestore();
  });

  it('rejects with CompartmentItemInvalidKeyError before any DynamoDB call when unitId contains the pk delimiter', async () => {
    const send = vi.fn();
    const client = fakeClient(send);

    await expect(listCompartmentItems(client, TABLE_NAME, DEPT_ID, 'EN#G')).rejects.toBeInstanceOf(
      CompartmentItemInvalidKeyError,
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe('putCompartmentItem', () => {
  it('writes a new item and an AUDIT_LOG_ENTRY in one TransactWriteItems, keyed by a dept-scoped pk built via buildDeptScopedPk, returning the item with a generated itemId (F9.4)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = fakeClient(send);
    const input = { compartmentCode: 'C1', itemName: 'Pike pole', quantity: 1 };

    const created = await putCompartmentItem(
      client,
      TABLE_NAME,
      DEPT_ID,
      'ENGINE-2',
      input,
      ACTOR_ID,
    );

    expect(created).toMatchObject(input);
    expect(created.itemId).toMatch(/^[0-9a-f-]{36}$/);
    const sentInput = (send.mock.calls[0]?.[0] as { input: { TransactItems: unknown[] } }).input;
    const [itemPut, auditPut] = sentInput.TransactItems as [
      { Put: { TableName: string; Item: Record<string, unknown>; ConditionExpression: string } },
      { Put: { TableName: string; Item: Record<string, unknown> } },
    ];
    expect(itemPut.Put.TableName).toBe(TABLE_NAME);
    expect(itemPut.Put.ConditionExpression).toBe(
      'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    );
    expect(itemPut.Put.Item).toMatchObject({
      pk: 'DEPT#dept-001#APPARATUS#ENGINE-2',
      entityType: 'COMPARTMENT_ITEM',
      ...input,
    });
    expect(auditPut.Put.TableName).toBe(TABLE_NAME);
    expect(auditPut.Put.Item).toMatchObject({
      pk: `DEPT#dept-001#AUDIT#${new Date().toISOString().slice(0, 10)}`,
      entityType: 'AUDIT_LOG_ENTRY',
      mutatedEntityType: 'COMPARTMENT_ITEM',
      mutatedEntityId: created.itemId,
      action: 'CREATE',
      actorId: ACTOR_ID,
      changedFields: {
        compartmentCode: { old: null, new: 'C1' },
        itemName: { old: null, new: 'Pike pole' },
        quantity: { old: null, new: 1 },
      },
    });
    expect(String(auditPut.Put.Item.sk)).toContain(
      `#COMPARTMENT_ITEM#${created.itemId}#${ACTOR_ID}`,
    );
  });

  it('wraps a transaction failure as CompartmentItemStoreUnavailableError, logging the original error first', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cause = new ConditionalCheckFailedException({
      message: 'The conditional request failed',
      $metadata: {},
    });
    const client = fakeClient(vi.fn().mockRejectedValue(cause));

    await expect(
      putCompartmentItem(
        client,
        TABLE_NAME,
        DEPT_ID,
        'ENGINE-2',
        { compartmentCode: 'C1', itemName: 'x', quantity: 1 },
        ACTOR_ID,
      ),
    ).rejects.toBeInstanceOf(CompartmentItemStoreUnavailableError);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('inventory.create.storeError'));
    logSpy.mockRestore();
  });

  it('rejects with CompartmentItemInvalidKeyError before any DynamoDB call when unitId contains the pk delimiter', async () => {
    const send = vi.fn();
    const client = fakeClient(send);

    await expect(
      putCompartmentItem(
        client,
        TABLE_NAME,
        DEPT_ID,
        'EN#G',
        { compartmentCode: 'C1', itemName: 'x', quantity: 1 },
        ACTOR_ID,
      ),
    ).rejects.toBeInstanceOf(CompartmentItemInvalidKeyError);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('updateCompartmentItemQuantity', () => {
  it('reads the current quantity, then conditionally updates it and writes an AUDIT_LOG_ENTRY with old/new quantity in one TransactWriteItems (F9.4), never a blind write', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: { pk: 'x', sk: 'y', quantity: 2 } })
      .mockResolvedValueOnce({});
    const client = fakeClient(send);

    await updateCompartmentItemQuantity(
      client,
      TABLE_NAME,
      DEPT_ID,
      'ENGINE-2',
      'CI-021',
      5,
      ACTOR_ID,
    );

    expect(send).toHaveBeenCalledTimes(2);
    const transactInput = (send.mock.calls[1]?.[0] as { input: { TransactItems: unknown[] } })
      .input;
    const [update, auditPut] = transactInput.TransactItems as [
      { Update: Record<string, unknown> },
      { Put: { Item: Record<string, unknown> } },
    ];
    expect(update.Update).toMatchObject({
      TableName: TABLE_NAME,
      Key: { pk: 'DEPT#dept-001#APPARATUS#ENGINE-2', sk: 'COMPARTMENT_ITEM#CI-021' },
      UpdateExpression: 'SET quantity = :quantity',
      ConditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
      ExpressionAttributeValues: { ':quantity': 5 },
    });
    expect(auditPut.Put.Item).toMatchObject({
      action: 'UPDATE',
      actorId: ACTOR_ID,
      mutatedEntityId: 'CI-021',
      changedFields: { quantity: { old: 2, new: 5 } },
    });
  });

  it('maps a conditional-update miss (unknown itemId) to CompartmentItemNotFoundError, logging first', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cause = new TransactionCanceledException({
      message: 'Transaction cancelled',
      $metadata: {},
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
    const send = vi.fn().mockResolvedValueOnce({ Item: undefined }).mockRejectedValueOnce(cause);
    const client = fakeClient(send);

    await expect(
      updateCompartmentItemQuantity(
        client,
        TABLE_NAME,
        DEPT_ID,
        'ENGINE-2',
        'unknown-item',
        5,
        ACTOR_ID,
      ),
    ).rejects.toBeInstanceOf(CompartmentItemNotFoundError);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('inventory.updateQuantity.notFound'),
    );
    logSpy.mockRestore();
  });

  it('wraps any other DynamoDB error as CompartmentItemStoreUnavailableError with a reason, logging first', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cause = new Error('ServiceUnavailableException');
    const send = vi.fn().mockResolvedValueOnce({ Item: undefined }).mockRejectedValueOnce(cause);
    const client = fakeClient(send);

    const rejection = updateCompartmentItemQuantity(
      client,
      TABLE_NAME,
      DEPT_ID,
      'ENGINE-2',
      'CI-021',
      5,
      ACTOR_ID,
    );
    await expect(rejection).rejects.toBeInstanceOf(CompartmentItemStoreUnavailableError);
    await expect(rejection).rejects.toMatchObject({ reason: 'Error' });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('inventory.updateQuantity.storeError'),
    );
    logSpy.mockRestore();
  });

  it('rejects with CompartmentItemInvalidKeyError before any DynamoDB call when itemId contains the pk delimiter', async () => {
    const send = vi.fn();
    const client = fakeClient(send);

    await expect(
      updateCompartmentItemQuantity(client, TABLE_NAME, DEPT_ID, 'ENGINE-2', 'CI#021', 5, ACTOR_ID),
    ).rejects.toBeInstanceOf(CompartmentItemInvalidKeyError);
    expect(send).not.toHaveBeenCalled();
  });
});
