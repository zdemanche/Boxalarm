import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  createSignupAttendance,
  createTrainingEvent,
  listAttendanceForPeriod,
  recordAttendanceHours,
} from './repository.js';

const TABLE_NAME = 'boxalarm-test-training-table';
const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-001' });
const CONFIG = { tableName: TABLE_NAME };

let container: StartedLocalStackContainer;
let ddbClient: DynamoDBClient;

beforeAll(async () => {
  container = await new LocalstackContainer('localstack/localstack:3').start();
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  process.env.AWS_REGION = 'us-east-1';
  ddbClient = new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' });
  await ddbClient.send(
    new CreateTableCommand({
      TableName: TABLE_NAME,
      BillingMode: 'PAY_PER_REQUEST',
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
    }),
  );
}, 120_000);

afterAll(async () => {
  ddbClient.destroy();
  await container.stop();
});

function documentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' }),
  );
}

describe('listAttendanceForPeriod (real DynamoDB via LocalStack)', () => {
  it('filters events by gsi3sk BETWEEN, fans out to ATTENDEE# rows, and excludes rows with no recorded hours (AC2, P3)', async () => {
    const client = documentClient();

    const inPeriodEvent = await createTrainingEvent(client, CONFIG, DEPT_ID, {
      title: 'In-period drill',
      category: 'ems',
      startAt: Date.UTC(2026, 5, 1),
      endAt: Date.UTC(2026, 5, 1, 2),
    });
    const outOfPeriodEvent = await createTrainingEvent(client, CONFIG, DEPT_ID, {
      title: 'Prior-year drill',
      category: 'ems',
      startAt: Date.UTC(2025, 5, 1),
      endAt: Date.UTC(2025, 5, 1, 2),
    });

    await recordAttendanceHours(client, CONFIG, DEPT_ID, inPeriodEvent, [
      { memberId: 'member-1', hours: 3 },
    ]);
    await createSignupAttendance(client, CONFIG, DEPT_ID, inPeriodEvent, 'member-2');
    await recordAttendanceHours(client, CONFIG, DEPT_ID, outOfPeriodEvent, [
      { memberId: 'member-3', hours: 4 },
    ]);

    const periodStart = Date.UTC(2026, 0, 1);
    const periodEnd = Date.UTC(2027, 0, 1) - 1;
    const records = await listAttendanceForPeriod(client, CONFIG, DEPT_ID, periodStart, periodEnd);

    expect(records).toEqual([
      { eventId: inPeriodEvent.eventId, memberId: 'member-1', category: 'ems', hours: 3 },
    ]);
  }, 60_000);
});
