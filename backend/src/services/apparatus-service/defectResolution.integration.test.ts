import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefect,
  DefectAlreadyResolvedError,
  listOpenDefects,
  resolveDefect,
} from './defectRepository.js';

/**
 * Review MAJOR-2, against real DynamoDB (LocalStack): the resolve path changes stored keys
 * (gsi3sk OPEN#{reportedAt} -> RESOLVED#{reportedAt}), so the index behavior is pinned here:
 * a resolved defect leaves the open-defects GSI3 list, the open list reads NEWEST first, the
 * row keeps its history (note, resolver, time), and a second resolve is refused.
 */

const TABLE = 'platform-table';
const DEPT = 'NICHOLS';
const deptId = toVerifiedDeptId({ deptId: DEPT });

describe('defect resolution against real DynamoDB', () => {
  let container: StartedLocalStackContainer;
  let docClient: DynamoDBDocumentClient;

  beforeAll(async () => {
    container = await new LocalstackContainer('localstack/localstack:3').start();
    const lowLevel = new DynamoDBClient({
      endpoint: container.getConnectionUri(),
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    docClient = DynamoDBDocumentClient.from(lowLevel, {
      marshallOptions: { removeUndefinedValues: true },
    });
    await lowLevel.send(
      new CreateTableCommand({
        TableName: TABLE,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
          { AttributeName: 'gsi3pk', AttributeType: 'S' },
          { AttributeName: 'gsi3sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI3',
            KeySchema: [
              { AttributeName: 'gsi3pk', KeyType: 'HASH' },
              { AttributeName: 'gsi3sk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    await docClient.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          pk: `DEPT#${DEPT}#APPARATUS#APP-E1`,
          sk: 'METADATA',
          apparatusId: 'APP-E1',
          unitId: 'E1',
          type: 'ENGINE',
          status: 'IN_SERVICE',
          gsi3pk: `DEPT#${DEPT}#APPARATUS`,
          gsi3sk: 'E1',
        },
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('resolve removes the defect from the open list, keeps its history, and refuses a repeat', async () => {
    const older = await createDefect(docClient, TABLE, {
      deptId,
      unitId: 'E1',
      description: 'Cracked mirror',
      severity: 'MINOR',
      reportedByMemberId: 'FF-1',
      correlationId: 'trace-older',
      now: () => 1_750_000_000,
    });
    const newer = await createDefect(docClient, TABLE, {
      deptId,
      unitId: 'E1',
      description: 'Pump will not engage',
      severity: 'OUT_OF_SERVICE',
      reportedByMemberId: 'FF-1',
      correlationId: 'trace-newer',
      now: () => 1_750_000_100,
    });

    // Newest first (MAJOR-2): the cap cuts the oldest, never a new defect.
    const before = await listOpenDefects(docClient, TABLE, deptId);
    expect(before.truncated).toBe(false);
    expect(before.defects.map((d) => d.defectId)).toEqual([newer.defectId, older.defectId]);

    const result = await resolveDefect(docClient, TABLE, {
      deptId,
      unitId: 'E1',
      defectId: newer.defectId,
      note: 'Replaced the pump seal',
      resolvedBy: 'LT-1',
    });
    expect(result.severity).toBe('OUT_OF_SERVICE');

    const after = await listOpenDefects(docClient, TABLE, deptId);
    expect(after.defects.map((d) => d.defectId)).toEqual([older.defectId]);

    const { Item: row } = await docClient.send(
      new GetCommand({
        TableName: TABLE,
        Key: { pk: `DEPT#${DEPT}#APPARATUS#APP-E1`, sk: `DEFECT#${newer.defectId}` },
        ConsistentRead: true,
      }),
    );
    expect(row).toMatchObject({
      status: 'RESOLVED',
      resolvedBy: 'LT-1',
      resolutionNote: 'Replaced the pump seal',
      gsi3sk: `RESOLVED#${newer.reportedAt}`,
    });
    expect(typeof row?.resolvedAt).toBe('number');

    await expect(
      resolveDefect(docClient, TABLE, {
        deptId,
        unitId: 'E1',
        defectId: newer.defectId,
        note: 'again',
        resolvedBy: 'LT-1',
      }),
    ).rejects.toBeInstanceOf(DefectAlreadyResolvedError);
  }, 60_000);
});
