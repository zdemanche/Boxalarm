import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { TrainingConfig } from './client.js';
import { aggregateMemberHoursByCategory, aggregateRosterHoursByCategory } from './hours.js';
import {
  createTrainingEvent,
  listEventAttendees,
  listMemberAttendanceInRange,
  listTrainingEventsInRange,
  recordAttendanceHours,
} from './repository.js';

const TABLE_NAME = 'boxalarm-test-training-table';
const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-hours' });

let container: StartedLocalStackContainer;
let ddbClient: DynamoDBClient;
let doc: DynamoDBDocumentClient;
let config: TrainingConfig;

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
        { AttributeName: 'gsi3pk', AttributeType: 'S' },
        { AttributeName: 'gsi3sk', AttributeType: 'S' },
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
  doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' }),
  );
  config = { tableName: TABLE_NAME };
}, 120_000);

afterAll(async () => {
  ddbClient.destroy();
  await container.stop();
});

describe('training hours roster-wide GSI1/GSI3 query pattern (real DynamoDB via LocalStack, AC2)', () => {
  it('aggregates per-member category hours over a date range without a per-member caller loop', async () => {
    const inRange = await createTrainingEvent(doc, config, DEPT_ID, {
      title: 'Ladder Ops',
      category: 'fireground',
      startAt: 1_000_000,
      endAt: 1_003_600,
    });
    const outOfRange = await createTrainingEvent(doc, config, DEPT_ID, {
      title: 'Old Drill',
      category: 'ems',
      startAt: 1,
      endAt: 100,
    });

    await recordAttendanceHours(doc, config, DEPT_ID, inRange, [
      { memberId: 'member-1', hours: 2 },
      { memberId: 'member-2', hours: 0 },
    ]);
    await recordAttendanceHours(doc, config, DEPT_ID, outOfRange, [
      { memberId: 'member-1', hours: 99 },
    ]);

    const events = await listTrainingEventsInRange(doc, config, DEPT_ID, {
      from: 500_000,
      to: 2_000_000,
    });
    expect(events.map((event) => event.eventId)).toEqual([inRange.eventId]);

    const attendeesByEvent = new Map(
      await Promise.all(
        events.map(
          async (event) =>
            [event.eventId, await listEventAttendees(doc, config, DEPT_ID, event.eventId)] as const,
        ),
      ),
    );
    const members = aggregateRosterHoursByCategory(events, attendeesByEvent);

    expect(members).toEqual(
      expect.arrayContaining([
        { memberId: 'member-1', categories: [{ category: 'fireground', hours: 2 }] },
        { memberId: 'member-2', categories: [{ category: 'fireground', hours: 0 }] },
      ]),
    );
    const member1 = members.find((member) => member.memberId === 'member-1');
    expect(member1?.categories.some((c) => c.hours === 99)).toBe(false);
  });

  it('member self-view (GSI1) reports the real hours/category values and matches the roster-wide totals for the same member/range (AC1, AC3)', async () => {
    const inRange = await createTrainingEvent(doc, config, DEPT_ID, {
      title: 'EMS Refresher',
      category: 'ems',
      startAt: 2_000_000,
      endAt: 2_003_600,
    });
    const outOfRange = await createTrainingEvent(doc, config, DEPT_ID, {
      title: 'Historic Drill',
      category: 'fireground',
      startAt: 1,
      endAt: 100,
    });

    await recordAttendanceHours(doc, config, DEPT_ID, inRange, [
      { memberId: 'member-3', hours: 5 },
    ]);
    await recordAttendanceHours(doc, config, DEPT_ID, outOfRange, [
      { memberId: 'member-3', hours: 100 },
    ]);

    const range = { from: 1_500_000, to: 2_500_000 };

    const selfRecords = await listMemberAttendanceInRange(doc, config, DEPT_ID, 'member-3', range);
    expect(selfRecords).toEqual([{ memberId: 'member-3', category: 'ems', hours: 5 }]);
    const selfCategories = aggregateMemberHoursByCategory(selfRecords);

    const events = await listTrainingEventsInRange(doc, config, DEPT_ID, range);
    const attendeesByEvent = new Map(
      await Promise.all(
        events.map(
          async (event) =>
            [event.eventId, await listEventAttendees(doc, config, DEPT_ID, event.eventId)] as const,
        ),
      ),
    );
    const rosterMembers = aggregateRosterHoursByCategory(events, attendeesByEvent);
    const rosterMember3 = rosterMembers.find((member) => member.memberId === 'member-3');

    expect(rosterMember3?.categories).toEqual(selfCategories);
  });

  it('still matches a pre-existing row whose gsi3sk was never zero-padded, because every real epoch-millisecond value is already 13 digits (V3 regression)', async () => {
    const legacyEventId = 'legacy-unpadded-event';
    const legacyStartAt = 1_700_000_000_000;
    await doc.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: buildDeptScopedPk(DEPT_ID, 'TRAINING_EVENT', legacyEventId),
          sk: 'METADATA',
          entityType: 'TRAINING_EVENT',
          eventId: legacyEventId,
          title: 'Pre-Deploy Legacy Drill',
          category: 'ems',
          startAt: legacyStartAt,
          endAt: legacyStartAt + 3_600_000,
          gsi3pk: buildDeptScopedPk(DEPT_ID, 'TRAINING_EVENT'),
          gsi3sk: String(legacyStartAt),
        },
      }),
    );

    const events = await listTrainingEventsInRange(doc, config, DEPT_ID, {
      from: legacyStartAt - 1_000,
      to: legacyStartAt + 1_000,
    });

    expect(events.map((event) => event.eventId)).toContain(legacyEventId);
  });
});
