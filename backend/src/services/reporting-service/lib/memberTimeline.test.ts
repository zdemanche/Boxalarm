import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  fetchAttendanceRecords,
  fetchMemberTimelines,
  statusAt,
  type MemberTimeline,
} from './memberTimeline.js';

function fakeClient(responses: readonly Record<string, unknown>[]): {
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  for (const response of responses) {
    send.mockResolvedValueOnce(response);
  }
  return { send };
}

describe('statusAt', () => {
  const timeline: MemberTimeline = {
    memberId: 'mbr-1',
    joinedAt: 100,
    intervals: [
      { status: 'PROBATIONARY', effectiveFrom: 100 },
      { status: 'ACTIVE', effectiveFrom: 200 },
      { status: 'RETIRED', effectiveFrom: 300 },
    ],
  };

  it('returns the status effective at or before the given instant', () => {
    expect(statusAt(timeline, 250)).toBe('ACTIVE');
    expect(statusAt(timeline, 200)).toBe('ACTIVE');
  });

  it('never reflects a status change retroactively into earlier instants (AC3)', () => {
    expect(statusAt(timeline, 299)).toBe('ACTIVE');
    expect(statusAt(timeline, 300)).toBe('RETIRED');
  });

  it('returns undefined before the member existed', () => {
    expect(statusAt(timeline, 50)).toBeUndefined();
  });
});

describe('fetchMemberTimelines', () => {
  it('builds ordered status intervals from ascending AUDIT_LOG_ENTRY history, joinedAt from the CREATE row', async () => {
    const client = fakeClient([
      { Items: [{ memberId: 'mbr-1', status: 'RETIRED', createdAt: 100 }] },
      {
        Items: [
          {
            mutatedEntityType: 'MEMBER',
            action: 'CREATE',
            changedFields: { status: { old: null, new: 'PROBATIONARY' } },
            ts: 100,
          },
          {
            mutatedEntityType: 'MEMBER',
            action: 'UPDATE',
            changedFields: { status: { old: 'PROBATIONARY', new: 'ACTIVE' } },
            ts: 200,
          },
          {
            mutatedEntityType: 'MEMBER',
            action: 'UPDATE',
            changedFields: { status: { old: 'ACTIVE', new: 'RETIRED' } },
            ts: 300,
          },
        ],
      },
    ]);

    const timelines = await fetchMemberTimelines(
      client as never,
      'personnel-table',
      'NICHOLS' as never,
    );

    expect(timelines).toEqual([
      {
        memberId: 'mbr-1',
        joinedAt: 100,
        intervals: [
          { status: 'PROBATIONARY', effectiveFrom: 100 },
          { status: 'ACTIVE', effectiveFrom: 200 },
          { status: 'RETIRED', effectiveFrom: 300 },
        ],
      },
    ]);

    const rosterCall = client.send.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect((rosterCall.input.ExpressionAttributeValues as Record<string, unknown>)[':gsi3pk']).toBe(
      'DEPT#NICHOLS#MEMBER',
    );
    const auditCall = client.send.mock.calls[1]?.[0] as { input: Record<string, unknown> };
    expect((auditCall.input.ExpressionAttributeValues as Record<string, unknown>)[':gsi3pk']).toBe(
      'DEPT#NICHOLS#AUDIT#ENTITY#MEMBER#mbr-1',
    );
  });

  it('falls back to MEMBER.status/createdAt for both intervals and joinedAt when no audit history exists', async () => {
    const client = fakeClient([
      { Items: [{ memberId: 'mbr-2', status: 'ACTIVE', createdAt: 500 }] },
      { Items: [] },
    ]);

    const timelines = await fetchMemberTimelines(
      client as never,
      'personnel-table',
      'NICHOLS' as never,
    );

    expect(timelines).toEqual([
      {
        memberId: 'mbr-2',
        joinedAt: 500,
        intervals: [{ status: 'ACTIVE', effectiveFrom: 500 }],
      },
    ]);
  });

  it('seeds the opening interval from member.createdAt (using the earliest row old-status) when the earliest retained audit row postdates createdAt (archived CREATE row, core-harm)', async () => {
    const client = fakeClient([
      { Items: [{ memberId: 'mbr-3', status: 'ACTIVE', createdAt: 100 }] },
      {
        Items: [
          {
            mutatedEntityType: 'MEMBER',
            action: 'UPDATE',
            changedFields: { status: { old: 'PROBATIONARY', new: 'ACTIVE' } },
            ts: 900,
          },
        ],
      },
    ]);

    const timelines = await fetchMemberTimelines(
      client as never,
      'personnel-table',
      'NICHOLS' as never,
    );

    expect(timelines).toEqual([
      {
        memberId: 'mbr-3',
        joinedAt: 100,
        intervals: [
          { status: 'PROBATIONARY', effectiveFrom: 100 },
          { status: 'ACTIVE', effectiveFrom: 900 },
        ],
      },
    ]);
  });

  it('excludes non-MEMBER audit entries from the reconstructed timeline', async () => {
    const client = fakeClient([
      { Items: [{ memberId: 'mbr-4', status: 'ACTIVE', createdAt: 100 }] },
      {
        Items: [
          {
            mutatedEntityType: 'APPARATUS',
            action: 'UPDATE',
            changedFields: { status: { old: 'ACTIVE', new: 'RETIRED' } },
            ts: 150,
          },
          {
            mutatedEntityType: 'MEMBER',
            action: 'UPDATE',
            changedFields: { status: { old: 'PROBATIONARY', new: 'ACTIVE' } },
            ts: 200,
          },
        ],
      },
    ]);

    const timelines = await fetchMemberTimelines(
      client as never,
      'personnel-table',
      'NICHOLS' as never,
    );

    expect(timelines[0]?.intervals).toEqual([
      { status: 'PROBATIONARY', effectiveFrom: 100 },
      { status: 'ACTIVE', effectiveFrom: 200 },
    ]);
  });

  it('paginates the roster query via ExclusiveStartKey/LastEvaluatedKey', async () => {
    const client = fakeClient([
      {
        Items: [{ memberId: 'mbr-1', status: 'ACTIVE', createdAt: 1 }],
        LastEvaluatedKey: { pk: 'p', sk: 's' },
      },
      { Items: [{ memberId: 'mbr-2', status: 'ACTIVE', createdAt: 2 }] },
      { Items: [] },
      { Items: [] },
    ]);

    const timelines = await fetchMemberTimelines(
      client as never,
      'personnel-table',
      'NICHOLS' as never,
    );

    expect(timelines.map((t) => t.memberId).sort()).toEqual(['mbr-1', 'mbr-2']);
    expect(client.send).toHaveBeenCalledTimes(4);
  });

  it('returns an empty timeline list for an empty roster', async () => {
    const client = fakeClient([{ Items: [] }]);

    const timelines = await fetchMemberTimelines(
      client as never,
      'personnel-table',
      'NICHOLS' as never,
    );

    expect(timelines).toEqual([]);
  });
});

describe('fetchMemberTimelines (real DynamoDB via LocalStack)', () => {
  const TABLE_NAME = 'boxalarm-test-personnel-table';
  const DEPT_ID = 'NICHOLS';
  let container: StartedLocalStackContainer;
  let ddbClient: DynamoDBClient;
  let docClient: DynamoDBDocumentClient;

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
    docClient = DynamoDBDocumentClient.from(ddbClient);
  }, 120_000);

  afterAll(async () => {
    ddbClient.destroy();
    await container.stop();
  });

  it('reconstructs a real roster + per-member audit-history timeline through GSI3 (P8)', async () => {
    const createdAt = Date.UTC(2025, 11, 1);
    const promotedAt = Date.UTC(2025, 11, 15);
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `DEPT#${DEPT_ID}#MEMBER#mbr-real`,
          sk: 'METADATA',
          entityType: 'MEMBER',
          memberId: 'mbr-real',
          status: 'ACTIVE',
          createdAt,
          gsi3pk: `DEPT#${DEPT_ID}#MEMBER`,
          gsi3sk: `Rios#mbr-real`,
        },
      }),
    );
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `DEPT#${DEPT_ID}#AUDIT#2025-12-01`,
          sk: `${createdAt}#MEMBER#mbr-real#actor-1`,
          entityType: 'AUDIT_LOG_ENTRY',
          mutatedEntityType: 'MEMBER',
          mutatedEntityId: 'mbr-real',
          action: 'CREATE',
          actorId: 'actor-1',
          changedFields: { status: { old: null, new: 'PROBATIONARY' } },
          ts: createdAt,
          gsi3pk: `DEPT#${DEPT_ID}#AUDIT#ENTITY#MEMBER#mbr-real`,
          gsi3sk: new Date(createdAt).toISOString(),
        },
      }),
    );
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `DEPT#${DEPT_ID}#AUDIT#2025-12-15`,
          sk: `${promotedAt}#MEMBER#mbr-real#actor-1`,
          entityType: 'AUDIT_LOG_ENTRY',
          mutatedEntityType: 'MEMBER',
          mutatedEntityId: 'mbr-real',
          action: 'UPDATE',
          actorId: 'actor-1',
          changedFields: { status: { old: 'PROBATIONARY', new: 'ACTIVE' } },
          ts: promotedAt,
          gsi3pk: `DEPT#${DEPT_ID}#AUDIT#ENTITY#MEMBER#mbr-real`,
          gsi3sk: new Date(promotedAt).toISOString(),
        },
      }),
    );

    const timelines = await fetchMemberTimelines(docClient, TABLE_NAME, DEPT_ID as never);

    expect(timelines).toEqual([
      {
        memberId: 'mbr-real',
        joinedAt: createdAt,
        intervals: [
          { status: 'PROBATIONARY', effectiveFrom: createdAt },
          { status: 'ACTIVE', effectiveFrom: promotedAt },
        ],
      },
    ]);
  });
});

describe('fetchAttendanceRecords', () => {
  it('queries GSI1 per member with epoch-second bounds and returns occurredAt in ms (AC2, epoch-seam)', async () => {
    const client = fakeClient([
      {
        Items: [
          { activityType: 'CALL', occurredAt: 1798000500 },
          { activityType: 'DRILL', occurredAt: 1798000600 },
        ],
      },
    ]);

    const startMs = Date.parse('2026-01-01');
    const endMs = Date.parse('2026-03-01');
    const records = await fetchAttendanceRecords(
      client as never,
      'platform-table',
      ['mbr-1'],
      startMs,
      endMs,
    );

    expect(records).toEqual([
      { memberId: 'mbr-1', activityType: 'CALL', occurredAt: 1798000500 * 1000 },
      { memberId: 'mbr-1', activityType: 'DRILL', occurredAt: 1798000600 * 1000 },
    ]);
    const call = client.send.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect(call.input.ExpressionAttributeValues).toEqual({
      ':gsi1pk': 'MEMBER#mbr-1',
      ':from': `ATTENDANCE_RECORD#${Math.floor(startMs / 1000)}`,
      ':to': `ATTENDANCE_RECORD#${Math.floor(endMs / 1000)}`,
    });
  });

  it('returns an item in the writer exact shape (buildAttendanceKeys occurredAt) and lands within the requested range', async () => {
    const client = fakeClient([{ Items: [{ activityType: 'DRILL', occurredAt: 1798000500 }] }]);

    const records = await fetchAttendanceRecords(
      client as never,
      'platform-table',
      ['mbr-102'],
      1798000000 * 1000,
      1798001000 * 1000,
    );

    expect(records).toEqual([
      { memberId: 'mbr-102', activityType: 'DRILL', occurredAt: 1798000500000 },
    ]);
  });

  it('discards malformed items missing a valid activityType or occurredAt', async () => {
    const client = fakeClient([
      { Items: [{ activityType: 'NOT_REAL', occurredAt: 150 }, { activityType: 'CALL' }] },
    ]);

    const records = await fetchAttendanceRecords(
      client as never,
      'platform-table',
      ['mbr-1'],
      100_000,
      200_000,
    );

    expect(records).toEqual([]);
  });

  it('paginates per member via ExclusiveStartKey/LastEvaluatedKey', async () => {
    const client = fakeClient([
      { Items: [{ activityType: 'CALL', occurredAt: 110 }], LastEvaluatedKey: { sk: 'x' } },
      { Items: [{ activityType: 'DRILL', occurredAt: 120 }] },
    ]);

    const records = await fetchAttendanceRecords(
      client as never,
      'platform-table',
      ['mbr-1'],
      100_000,
      200_000,
    );

    expect(records).toHaveLength(2);
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('returns an empty list when no member ids are given', async () => {
    const client = fakeClient([]);

    const records = await fetchAttendanceRecords(
      client as never,
      'platform-table',
      [],
      100_000,
      200_000,
    );

    expect(records).toEqual([]);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('queries multiple members concurrently without exceeding one round trip per member', async () => {
    const client = fakeClient([{ Items: [] }, { Items: [] }, { Items: [] }]);

    await fetchAttendanceRecords(
      client as never,
      'platform-table',
      ['mbr-1', 'mbr-2', 'mbr-3'],
      100_000,
      200_000,
    );

    expect(client.send).toHaveBeenCalledTimes(3);
  });
});

describe('fetchAttendanceRecords (real DynamoDB via LocalStack)', () => {
  const TABLE_NAME = 'boxalarm-test-platform-table';
  let container: StartedLocalStackContainer;
  let ddbClient: DynamoDBClient;
  let docClient: DynamoDBDocumentClient;

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
          { AttributeName: 'gsi1pk', AttributeType: 'S' },
          { AttributeName: 'gsi1sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI1',
            KeySchema: [
              { AttributeName: 'gsi1pk', KeyType: 'HASH' },
              { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      }),
    );
    docClient = DynamoDBDocumentClient.from(ddbClient);
  }, 120_000);

  afterAll(async () => {
    ddbClient.destroy();
    await container.stop();
  });

  it('returns a record written in the writer exact shape (buildAttendanceKeys) and lands it in the requested bucket (P7, epoch-seam)', async () => {
    const occurredAtSec = Math.floor(Date.UTC(2026, 1, 10) / 1000);
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: 'DEPT#NICHOLS#MEMBER#mbr-real',
          sk: `ATTENDANCE#${occurredAtSec}`,
          entityType: 'ATTENDANCE_RECORD',
          activityType: 'DRILL',
          refId: null,
          occurredAt: occurredAtSec,
          hours: 2,
          losapPointsAwarded: 0,
          gsi1pk: 'MEMBER#mbr-real',
          gsi1sk: `ATTENDANCE_RECORD#${occurredAtSec}`,
        },
      }),
    );

    const records = await fetchAttendanceRecords(
      docClient,
      TABLE_NAME,
      ['mbr-real'],
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 2, 1),
    );

    expect(records).toEqual([
      { memberId: 'mbr-real', activityType: 'DRILL', occurredAt: occurredAtSec * 1000 },
    ]);
  });

  it('excludes a real record whose occurredAt falls outside the requested range', async () => {
    const outsideSec = Math.floor(Date.UTC(2025, 5, 1) / 1000);
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: 'DEPT#NICHOLS#MEMBER#mbr-outside',
          sk: `ATTENDANCE#${outsideSec}`,
          entityType: 'ATTENDANCE_RECORD',
          activityType: 'CALL',
          refId: null,
          occurredAt: outsideSec,
          hours: 1,
          losapPointsAwarded: 0,
          gsi1pk: 'MEMBER#mbr-outside',
          gsi1sk: `ATTENDANCE_RECORD#${outsideSec}`,
        },
      }),
    );

    const records = await fetchAttendanceRecords(
      docClient,
      TABLE_NAME,
      ['mbr-outside'],
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 2, 1),
    );

    expect(records).toEqual([]);
  });
});
