import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { releaseShiftPosition } from './releaseShiftPosition.js';
import { approveShiftSwap, proposeShiftSwap } from './shiftSwap.js';
import { buildDutyShift, buildShiftPosition } from './testFixtures.js';

const TABLE_NAME = 'boxalarm-test-platform-table';
const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-integration' });

let container: StartedLocalStackContainer;
let ddbClient: DynamoDBClient;
let doc: DynamoDBDocumentClient;

beforeAll(async () => {
  container = await new LocalstackContainer('localstack/localstack:3').start();
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  process.env.AWS_REGION = 'us-east-1';
  ddbClient = new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' });
  doc = DynamoDBDocumentClient.from(ddbClient);

  await ddbClient.send(
    new CreateTableCommand({
      TableName: TABLE_NAME,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    }),
  );
}, 120_000);

afterAll(async () => {
  ddbClient.destroy();
  await container.stop();
});

async function seed(items: readonly Record<string, unknown>[]): Promise<void> {
  for (const item of items) {
    await doc.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  }
}

describe('shifts data-access layer (real DynamoDB via LocalStack)', () => {
  it('AC1: releaseShiftPosition clears the claim via TransactWriteCommand ConditionExpression', async () => {
    const shiftId = `SHIFT-${Date.now()}-release`;
    await seed([
      buildDutyShift(DEPT_ID, shiftId),
      {
        ...buildShiftPosition(DEPT_ID, shiftId, 'DRIVER', { claimedByMemberId: 'MBR-1' }),
        gsi1pk: 'MEMBER#MBR-1',
        gsi1sk: 'SHIFT_POSITION#1800000000',
      },
    ]);

    const outcome = await releaseShiftPosition(
      doc,
      TABLE_NAME,
      DEPT_ID,
      shiftId,
      'DRIVER',
      'MBR-1',
    );

    expect(outcome).toEqual({ kind: 'RELEASED' });
    const stored = await doc.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: buildDeptScopedPk(DEPT_ID, 'SHIFT', shiftId), sk: 'POSITION#DRIVER' },
      }),
    );
    expect(stored.Item?.claimedByMemberId).toBeUndefined();
    expect(stored.Item?.gsi1pk).toBeUndefined();
  });

  it('core-harm: releaseShiftPosition rejects a release from a member who does not hold the position (ConditionExpression fails against real DynamoDB)', async () => {
    const shiftId = `SHIFT-${Date.now()}-release-conflict`;
    await seed([
      buildDutyShift(DEPT_ID, shiftId),
      buildShiftPosition(DEPT_ID, shiftId, 'DRIVER', { claimedByMemberId: 'MBR-1' }),
    ]);

    const outcome = await releaseShiftPosition(
      doc,
      TABLE_NAME,
      DEPT_ID,
      shiftId,
      'DRIVER',
      'MBR-9',
    );

    expect(outcome).toEqual({ kind: 'NOT_CLAIMED_BY_YOU' });
    const stored = await doc.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: buildDeptScopedPk(DEPT_ID, 'SHIFT', shiftId), sk: 'POSITION#DRIVER' },
      }),
    );
    expect(stored.Item?.claimedByMemberId).toBe('MBR-1');
  });

  it('AC2: proposeShiftSwap creates a PENDING SHIFT_SWAP_REQUEST via TransactWriteCommand ConditionCheck', async () => {
    const shiftId = `SHIFT-${Date.now()}-propose`;
    await seed([
      buildDutyShift(DEPT_ID, shiftId),
      buildShiftPosition(DEPT_ID, shiftId, 'DRIVER', { claimedByMemberId: 'MBR-1' }),
    ]);

    const outcome = await proposeShiftSwap(
      doc,
      TABLE_NAME,
      DEPT_ID,
      shiftId,
      'DRIVER',
      'MBR-1',
      'MBR-2',
    );

    expect(outcome).toMatchObject({ kind: 'PROPOSED' });
    const requestedAt = (outcome as { requestedAt: number }).requestedAt;
    const stored = await doc.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: buildDeptScopedPk(DEPT_ID, 'SHIFT', shiftId), sk: `SWAP#${requestedAt}` },
      }),
    );
    expect(stored.Item?.status).toBe('PENDING');
  });

  it('core-harm: proposeShiftSwap rejects a swap from a member who does not hold the position', async () => {
    const shiftId = `SHIFT-${Date.now()}-propose-conflict`;
    await seed([
      buildDutyShift(DEPT_ID, shiftId),
      buildShiftPosition(DEPT_ID, shiftId, 'DRIVER', { claimedByMemberId: 'MBR-1' }),
    ]);

    const outcome = await proposeShiftSwap(
      doc,
      TABLE_NAME,
      DEPT_ID,
      shiftId,
      'DRIVER',
      'MBR-9',
      'MBR-2',
    );

    expect(outcome).toEqual({ kind: 'NOT_CLAIMED_BY_YOU' });
  });

  it('AC4: approveShiftSwap transfers claimedByMemberId via a multi-item TransactWriteCommand', async () => {
    const shiftId = `SHIFT-${Date.now()}-approve`;
    const requestedAt = Date.now();
    await seed([
      buildDutyShift(DEPT_ID, shiftId),
      buildShiftPosition(DEPT_ID, shiftId, 'DRIVER', { claimedByMemberId: 'MBR-1' }),
      {
        pk: buildDeptScopedPk(DEPT_ID, 'SHIFT', shiftId),
        sk: `SWAP#${requestedAt}`,
        entityType: 'SHIFT_SWAP_REQUEST',
        positionCode: 'DRIVER',
        fromMemberId: 'MBR-1',
        toMemberId: 'MBR-2',
        status: 'PENDING',
        requiresOfficerApproval: true,
        requestedAt,
      },
    ]);

    const outcome = await approveShiftSwap(doc, TABLE_NAME, DEPT_ID, shiftId, requestedAt);

    expect(outcome).toEqual({ kind: 'APPROVED', toMemberId: 'MBR-2' });
    const stored = await doc.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: buildDeptScopedPk(DEPT_ID, 'SHIFT', shiftId), sk: 'POSITION#DRIVER' },
      }),
    );
    expect(stored.Item?.claimedByMemberId).toBe('MBR-2');
  });

  it('core-harm: approveShiftSwap rejects approval when the swap already resolved (ConditionExpression on status)', async () => {
    const shiftId = `SHIFT-${Date.now()}-approve-not-pending`;
    const requestedAt = Date.now();
    await seed([
      buildDutyShift(DEPT_ID, shiftId),
      buildShiftPosition(DEPT_ID, shiftId, 'DRIVER', { claimedByMemberId: 'MBR-2' }),
      {
        pk: buildDeptScopedPk(DEPT_ID, 'SHIFT', shiftId),
        sk: `SWAP#${requestedAt}`,
        entityType: 'SHIFT_SWAP_REQUEST',
        positionCode: 'DRIVER',
        fromMemberId: 'MBR-1',
        toMemberId: 'MBR-2',
        status: 'APPROVED',
        requiresOfficerApproval: true,
        requestedAt,
      },
    ]);

    const outcome = await approveShiftSwap(doc, TABLE_NAME, DEPT_ID, shiftId, requestedAt);

    expect(outcome).toEqual({ kind: 'NOT_PENDING' });
  });
});
