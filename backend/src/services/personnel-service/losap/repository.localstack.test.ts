import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { buildLosapEntryItem, getMemberLosapTotal, getYearEndReport } from './repository.js';
import { getLosapPointRules, putLosapPointRules } from './configRepository.js';

const TABLE_NAME = 'personnel-losap-test';
const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

describe('LOSAP repository (real DynamoDB via LocalStack)', () => {
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
        TableName: TABLE_NAME,
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

  it('sums real LOSAP_POINT_ENTRY items scoped to the caller dept + member partition (AC3)', async () => {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: buildLosapEntryItem({
          deptId: DEPT_ID,
          memberId: 'mbr-201',
          year: 2026,
          activityType: 'CALL',
          points: 2,
          sourceRefId: 'ATTENDANCE#1',
          ruleVersionId: 'RULE-1',
          entryId: 'entry-1',
        }),
      }),
    );
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: buildLosapEntryItem({
          deptId: DEPT_ID,
          memberId: 'mbr-201',
          year: 2026,
          activityType: 'DRILL',
          points: 3,
          sourceRefId: 'ATTENDANCE#2',
          ruleVersionId: 'RULE-1',
          entryId: 'entry-2',
        }),
      }),
    );

    const total = await getMemberLosapTotal(client, TABLE_NAME, DEPT_ID, 'mbr-201', 2026);
    expect(total).toBe(5);
  });

  it('produces a dept-wide year-end report from real per-member partitions (AC4)', async () => {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: buildLosapEntryItem({
          deptId: DEPT_ID,
          memberId: 'mbr-301',
          year: 2027,
          activityType: 'CALL',
          points: 4,
          sourceRefId: 'ATTENDANCE#3',
          ruleVersionId: 'RULE-1',
          entryId: 'entry-3',
        }),
      }),
    );

    const report = await getYearEndReport(
      client,
      TABLE_NAME,
      DEPT_ID,
      ['mbr-301', 'mbr-999'],
      2027,
    );
    expect(report).toEqual([
      { memberId: 'mbr-301', totalPoints: 4 },
      { memberId: 'mbr-999', totalPoints: 0 },
    ]);
  });

  it('round-trips a versioned rule set through putLosapPointRules/getLosapPointRules (AC1)', async () => {
    const saved = await putLosapPointRules(
      client,
      TABLE_NAME,
      DEPT_ID,
      { CALL: 2, DRILL: 1 },
      undefined,
      'mbr-admin-1',
    );

    const fetched = await getLosapPointRules(client, TABLE_NAME, DEPT_ID);
    expect(fetched).toEqual({
      ruleVersionId: saved.ruleVersionId,
      pointsByActivityType: { CALL: 2, DRILL: 1 },
      version: 1,
    });
  });
});
