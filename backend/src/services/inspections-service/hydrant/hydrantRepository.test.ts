import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  HydrantAlreadyExistsError,
  HydrantNotFoundError,
  createHydrant,
  queryHydrantsDueWithin,
  updateHydrant,
} from './hydrantRepository.js';
import type { CreateHydrantInput } from './hydrantRepository.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

const createInput: CreateHydrantInput = {
  hydrantId: 'HYD-0231',
  latitude: 41.2417,
  longitude: -73.2004,
  size: '6-inch',
  flowRatingGpm: 1000,
  nextFlowTestDue: '2027-01-10',
  status: 'IN_SERVICE',
};

beforeEach(() => {
  ddbMock.reset();
  process.env.PLATFORM_TABLE_NAME = 'boxalarm-platform-table';
});

describe('createHydrant (AC1)', () => {
  it('writes the HYDRANT item with GSI2 due-date and GSI3 geohash keys populated', async () => {
    ddbMock.on(PutCommand).resolves({});
    const hydrant = await createHydrant(deptId, createInput);
    expect(hydrant.pk).toBe('DEPT#NICHOLS#HYDRANT#HYD-0231');
    expect(hydrant.sk).toBe('METADATA');
    expect(hydrant.gsi2pk).toBe('DEPT#NICHOLS#DUE#HYDRANT#2027-01');
    expect(hydrant.gsi2sk).toBe('2027-01-10#HYD-0231');
    expect(hydrant.gsi3pk).toMatch(/^DEPT#NICHOLS#HYDRANT#GEO#/);
    expect(hydrant.gsi3sk).toContain('#HYD-0231');
  });

  it('core-harm: writes the exact gsi2/gsi3 key literals so due-date scheduling and map resolution can find the hydrant', async () => {
    ddbMock.on(PutCommand).resolves({});
    await createHydrant(deptId, createInput);
    const call = ddbMock.commandCalls(PutCommand)[0];
    const item = call?.args[0].input.Item as Record<string, unknown> | undefined;
    expect(item?.gsi2pk).toBe('DEPT#NICHOLS#DUE#HYDRANT#2027-01');
    expect(item?.gsi2sk).toBe('2027-01-10#HYD-0231');
    expect(item?.gsi3pk).toMatch(/^DEPT#NICHOLS#HYDRANT#GEO#[0-9b-hj-km-np-z]{5}$/);
    expect(item?.gsi3sk).toMatch(/^[0-9b-hj-km-np-z]{8}#HYD-0231$/);
  });

  it('conditions the put on attribute_not_exists(pk) and maps a collision to HydrantAlreadyExistsError', async () => {
    ddbMock
      .on(PutCommand)
      .rejects(
        new ConditionalCheckFailedException({ message: 'conditional check failed', $metadata: {} }),
      );
    await expect(createHydrant(deptId, createInput)).rejects.toThrow(HydrantAlreadyExistsError);
  });

  it('fails closed (rethrows) on an unrecognized DynamoDB failure', async () => {
    ddbMock.on(PutCommand).rejects(new Error('simulated outage'));
    await expect(createHydrant(deptId, createInput)).rejects.toThrow('simulated outage');
  });
});

describe('updateHydrant (AC2)', () => {
  it('transacts the item update and an inspections.hydrant.updated outbox item, then returns the persisted record', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(GetCommand).resolves({
      Item: { pk: 'DEPT#NICHOLS#HYDRANT#HYD-0231', sk: 'METADATA', status: 'OUT_OF_SERVICE' },
    });

    const result = await updateHydrant(deptId, 'HYD-0231', { status: 'OUT_OF_SERVICE' }, 'corr-1');
    expect(result.status).toBe('OUT_OF_SERVICE');

    const call = ddbMock.commandCalls(TransactWriteCommand)[0];
    const items = call?.args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]?.Update?.ConditionExpression).toBe('attribute_exists(pk)');
    expect(items[1]?.Put?.Item?.entityType).toBe('OUTBOX_EVENT');
    expect(items[1]?.Put?.Item?.eventType).toBe('inspections.hydrant.updated');
    expect(items[1]?.Put?.Item?.correlationId).toBe('corr-1');
    expect(items[1]?.Put?.Item?.payload).toMatchObject({
      hydrantId: 'HYD-0231',
      status: 'OUT_OF_SERVICE',
    });
  });

  it('AC3: the persisted status field survives untransformed (OUT_OF_SERVICE stays OUT_OF_SERVICE)', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(GetCommand).resolves({
      Item: { pk: 'DEPT#NICHOLS#HYDRANT#HYD-0231', sk: 'METADATA', status: 'OUT_OF_SERVICE' },
    });
    const result = await updateHydrant(deptId, 'HYD-0231', { status: 'OUT_OF_SERVICE' }, 'corr-1');
    expect(result.status).toBe('OUT_OF_SERVICE');
  });

  it('recomputes gsi2pk/gsi2sk when nextFlowTestDue changes', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: { status: 'IN_SERVICE' } });
    await updateHydrant(deptId, 'HYD-0231', { nextFlowTestDue: '2028-03-05' }, 'corr-1');
    const call = ddbMock.commandCalls(TransactWriteCommand)[0];
    const update = call?.args[0].input.TransactItems?.[0]?.Update;
    expect(update?.ExpressionAttributeValues?.[':gsi2pk']).toBe('DEPT#NICHOLS#DUE#HYDRANT#2028-03');
    expect(update?.ExpressionAttributeValues?.[':gsi2sk']).toBe('2028-03-05#HYD-0231');
  });

  it('reads back the persisted item with ConsistentRead so a stale pre-update image can never be returned', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: { status: 'OUT_OF_SERVICE' } });
    await updateHydrant(deptId, 'HYD-0231', { status: 'OUT_OF_SERVICE' }, 'corr-1');
    const call = ddbMock.commandCalls(GetCommand)[0];
    expect(call?.args[0].input.ConsistentRead).toBe(true);
  });

  it('throws HydrantNotFoundError instead of returning an undefined body when the read-back finds no item', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(GetCommand).resolves({});
    await expect(
      updateHydrant(deptId, 'HYD-0231', { status: 'OUT_OF_SERVICE' }, 'corr-1'),
    ).rejects.toThrow(HydrantNotFoundError);
  });

  it('maps a failed attribute_exists(pk) condition to HydrantNotFoundError (404 path)', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );
    await expect(
      updateHydrant(deptId, 'HYD-9999', { status: 'OUT_OF_SERVICE' }, 'corr-1'),
    ).rejects.toThrow(HydrantNotFoundError);
  });

  it('fails closed (rethrows) on a non-conditional transaction failure', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'None' }, { Code: 'ThrottlingError' }],
      }),
    );
    await expect(
      updateHydrant(deptId, 'HYD-0231', { status: 'OUT_OF_SERVICE' }, 'corr-1'),
    ).rejects.toThrow(TransactionCanceledException);
  });
});

describe('queryHydrantsDueWithin (AC4)', () => {
  it('returns [] for a department with zero due hydrants, without throwing', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const result = await queryHydrantsDueWithin(deptId, '2027-01');
    expect(result).toEqual([]);
  });

  it('queries GSI2 keyed on the month-bucketed due partition', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ hydrantId: 'HYD-0231' }] });
    const result = await queryHydrantsDueWithin(deptId, '2027-01');
    expect(result).toEqual([{ hydrantId: 'HYD-0231' }]);
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call?.args[0].input.IndexName).toBe('GSI2');
    expect(call?.args[0].input.ExpressionAttributeValues).toEqual({
      ':gsi2pk': 'DEPT#NICHOLS#DUE#HYDRANT#2027-01',
    });
  });

  it('fails closed (rethrows) on a DynamoDB Query failure rather than swallowing it', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('simulated throttling'));
    await expect(queryHydrantsDueWithin(deptId, '2027-01')).rejects.toThrow('simulated throttling');
  });
});
