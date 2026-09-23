import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { PrePlanCopyDependencyError, getPrePlanCopy } from './prePlanCopyRepository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'alerting-table';

function fakeDoc(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('getPrePlanCopy', () => {
  it('resolves via a single Query on the department PREPLAN partition (AC1, AC3)', async () => {
    const item = {
      summary: 'Two-story residential, propane tank rear',
      hazards: ['LPG_TANK_REAR'],
      utilityShutoffs: [{ utility: 'GAS', location: 'rear of building' }],
      nearestHydrants: [{ id: 'HYD-1', location: 'corner', size: '6in', flow: '1000gpm' }],
      snapshotUpdatedAt: 1798000000,
    };
    const send = vi.fn().mockResolvedValue({ Items: [item] });
    const result = await getPrePlanCopy(fakeDoc(send), TABLE, DEPT_ID, 'OCC-1');
    expect(result).toEqual(item);
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect(command.input.ExpressionAttributeValues).toEqual({
      ':pk': 'DEPT#NICHOLS#PREPLAN',
      ':sk': 'OCCUPANCY#OCC-1',
    });
  });

  it('returns undefined when no PRE_PLAN_COPY exists for the occupancy (AC2)', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const result = await getPrePlanCopy(fakeDoc(send), TABLE, DEPT_ID, 'OCC-1');
    expect(result).toBeUndefined();
  });

  it('wraps a DynamoDB failure in PrePlanCopyDependencyError', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
    await expect(getPrePlanCopy(fakeDoc(send), TABLE, DEPT_ID, 'OCC-1')).rejects.toThrow(
      PrePlanCopyDependencyError,
    );
  });
});

describe('getPrePlanCopy (real DynamoDB, AC1/AC3)', () => {
  const REAL_TABLE = 'alerting-preplan-test';
  let container: StartedLocalStackContainer;
  let client: DynamoDBDocumentClient;

  beforeAll(async () => {
    container = await new LocalstackContainer('localstack/localstack:4').start();
    const base = new DynamoDBClient({
      endpoint: container.getConnectionUri(),
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await base.send(
      new CreateTableCommand({
        TableName: REAL_TABLE,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    client = DynamoDBDocumentClient.from(base);
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  it('resolves the PRE_PLAN_COPY item via the department PREPLAN partition and occupancy sk (AC1)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const occupancyId = `OCC-${randomUUID()}`;
    const item = {
      summary: 'Two-story residential, propane tank rear',
      hazards: ['LPG_TANK_REAR'],
      utilityShutoffs: [{ utility: 'GAS', location: 'rear of building' }],
      nearestHydrants: [{ id: 'HYD-1', location: 'corner', size: '6in', flow: '1000gpm' }],
      snapshotUpdatedAt: 1798000000,
    };
    await client.send(
      new PutCommand({
        TableName: REAL_TABLE,
        Item: {
          pk: `DEPT#${deptId}#PREPLAN`,
          sk: `OCCUPANCY#${occupancyId}`,
          entityType: 'PRE_PLAN_COPY',
          ...item,
        },
      }),
    );

    const result = await getPrePlanCopy(client, REAL_TABLE, deptId, occupancyId);
    expect(result).toMatchObject(item);
  });

  it('returns undefined when no PRE_PLAN_COPY exists for the occupancy (AC2)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const result = await getPrePlanCopy(client, REAL_TABLE, deptId, `no-such-${randomUUID()}`);
    expect(result).toBeUndefined();
  });
});
