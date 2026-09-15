import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import type { GrantsReportConfig } from '../client.js';
import {
  getActiveMemberCountAndTrend,
  getApparatusOosHistory,
  getTrainingHoursCompliance,
} from './repository.js';

const PERSONNEL_TABLE = 'reporting-personnel-test';
const TRAINING_TABLE = 'reporting-training-test';
const PLATFORM_TABLE = 'reporting-platform-test';
const PERIOD = { periodStart: 1_700_000_000_000, periodEnd: 1_701_000_000_000 };

function freshDeptId(): VerifiedDeptId {
  return toVerifiedDeptId({ deptId: `DEPT-${randomUUID().replace(/-/g, '').slice(0, 12)}` });
}

async function createGsi3Table(base: DynamoDBClient, tableName: string): Promise<void> {
  await base.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi3pk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI3',
          KeySchema: [{ AttributeName: 'gsi3pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
}

describe('reporting-service grants repository (real DynamoDB)', () => {
  let container: StartedLocalStackContainer;
  let client: DynamoDBDocumentClient;
  let config: GrantsReportConfig;

  beforeAll(async () => {
    container = await new LocalstackContainer('localstack/localstack:4').start();
    const base = new DynamoDBClient({
      endpoint: container.getConnectionUri(),
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await Promise.all([
      createGsi3Table(base, PERSONNEL_TABLE),
      createGsi3Table(base, TRAINING_TABLE),
      createGsi3Table(base, PLATFORM_TABLE),
    ]);
    client = DynamoDBDocumentClient.from(base);
    config = {
      personnelTableName: PERSONNEL_TABLE,
      trainingTableName: TRAINING_TABLE,
      platformTableName: PLATFORM_TABLE,
    };
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  describe('getActiveMemberCountAndTrend', () => {
    it('counts ACTIVE members and members who joined within the period (AC1)', async () => {
      const deptId = freshDeptId();
      await Promise.all(
        [
          { memberId: 'MBR-1', status: 'ACTIVE', joinDate: '2023-11-20' },
          { memberId: 'MBR-2', status: 'ACTIVE', joinDate: '2020-01-01' },
          { memberId: 'MBR-3', status: 'RETIRED', joinDate: '2020-01-01' },
        ].map((member) =>
          client.send(
            new PutCommand({
              TableName: PERSONNEL_TABLE,
              Item: {
                pk: buildDeptScopedPk(deptId, 'MEMBER', member.memberId),
                sk: 'METADATA',
                gsi3pk: buildDeptScopedPk(deptId, 'MEMBER'),
                status: member.status,
                joinDate: member.joinDate,
              },
            }),
          ),
        ),
      );

      const result = await getActiveMemberCountAndTrend(client, config, deptId, PERIOD);

      expect(result).toEqual({ activeMemberCount: 2, joinedInPeriod: 1 });
    });

    it('excludes a member with a malformed joinDate from joinedInPeriod rather than throwing (routine-input row)', async () => {
      const deptId = freshDeptId();
      await client.send(
        new PutCommand({
          TableName: PERSONNEL_TABLE,
          Item: {
            pk: buildDeptScopedPk(deptId, 'MEMBER', 'MBR-1'),
            sk: 'METADATA',
            gsi3pk: buildDeptScopedPk(deptId, 'MEMBER'),
            status: 'ACTIVE',
            joinDate: 'not-a-date',
          },
        }),
      );

      const result = await getActiveMemberCountAndTrend(client, config, deptId, PERIOD);

      expect(result.joinedInPeriod).toBe(0);
    });

    it('logs the original error and rethrows when the roster Query fails (error-path-logging)', async () => {
      const deptId = freshDeptId();
      const badConfig: GrantsReportConfig = { ...config, personnelTableName: 'no-such-table' };

      await expect(
        getActiveMemberCountAndTrend(client, badConfig, deptId, PERIOD),
      ).rejects.toThrow();
    });
  });

  describe('getTrainingHoursCompliance', () => {
    it('sums attendee hours for events within the period, normalizing epoch-second startAt against the epoch-ms period bounds (AC1, P1 unit fix)', async () => {
      const deptId = freshDeptId();
      await client.send(
        new PutCommand({
          TableName: TRAINING_TABLE,
          Item: {
            pk: buildDeptScopedPk(deptId, 'TRAINING_EVENT', 'EVT-1'),
            sk: 'METADATA',
            gsi3pk: buildDeptScopedPk(deptId, 'TRAINING_EVENT'),
            eventId: 'EVT-1',
            startAt: 1_700_500_000,
          },
        }),
      );
      await client.send(
        new PutCommand({
          TableName: TRAINING_TABLE,
          Item: {
            pk: buildDeptScopedPk(deptId, 'TRAINING_EVENT', 'EVT-2'),
            sk: 'METADATA',
            gsi3pk: buildDeptScopedPk(deptId, 'TRAINING_EVENT'),
            eventId: 'EVT-2',
            startAt: 1_699_000_000,
          },
        }),
      );
      await Promise.all(
        [
          { memberId: 'MBR-1', hours: 4 },
          { memberId: 'MBR-2', hours: 2 },
        ].map((attendee) =>
          client.send(
            new PutCommand({
              TableName: TRAINING_TABLE,
              Item: {
                pk: buildDeptScopedPk(deptId, 'TRAINING_EVENT', 'EVT-1'),
                sk: `ATTENDEE#${attendee.memberId}`,
                memberId: attendee.memberId,
                hours: attendee.hours,
              },
            }),
          ),
        ),
      );
      await client.send(
        new PutCommand({
          TableName: TRAINING_TABLE,
          Item: {
            pk: buildDeptScopedPk(deptId, 'TRAINING_EVENT', 'EVT-2'),
            sk: 'ATTENDEE#MBR-3',
            memberId: 'MBR-3',
            hours: 9,
          },
        }),
      );

      const result = await getTrainingHoursCompliance(client, config, deptId, PERIOD);

      expect(result).toEqual({ totalHours: 6, memberCount: 2, eventCount: 1 });
    });

    it('treats a missing/non-numeric/negative hours value as 0 rather than throwing (routine-input row)', async () => {
      const deptId = freshDeptId();
      await client.send(
        new PutCommand({
          TableName: TRAINING_TABLE,
          Item: {
            pk: buildDeptScopedPk(deptId, 'TRAINING_EVENT', 'EVT-1'),
            sk: 'METADATA',
            gsi3pk: buildDeptScopedPk(deptId, 'TRAINING_EVENT'),
            eventId: 'EVT-1',
            startAt: 1_700_500_000,
          },
        }),
      );
      await Promise.all(
        [
          { memberId: 'MBR-1', hours: 'not-a-number' as unknown },
          { memberId: 'MBR-2', hours: -3 },
          { memberId: 'MBR-3', hours: undefined },
        ].map((attendee) =>
          client.send(
            new PutCommand({
              TableName: TRAINING_TABLE,
              Item: {
                pk: buildDeptScopedPk(deptId, 'TRAINING_EVENT', 'EVT-1'),
                sk: `ATTENDEE#${attendee.memberId}`,
                memberId: attendee.memberId,
                ...(attendee.hours === undefined ? {} : { hours: attendee.hours }),
              },
            }),
          ),
        ),
      );

      const result = await getTrainingHoursCompliance(client, config, deptId, PERIOD);

      expect(result.totalHours).toBe(0);
      expect(result.memberCount).toBe(3);
    });

    it('returns a zero-value result when the department has no training events yet', async () => {
      const deptId = freshDeptId();

      const result = await getTrainingHoursCompliance(client, config, deptId, PERIOD);

      expect(result).toEqual({ totalHours: 0, memberCount: 0, eventCount: 0 });
    });

    it('logs the original error and rethrows when a Query fails (error-path-logging)', async () => {
      const deptId = freshDeptId();
      const badConfig: GrantsReportConfig = { ...config, trainingTableName: 'no-such-table' };

      await expect(getTrainingHoursCompliance(client, badConfig, deptId, PERIOD)).rejects.toThrow();
    });
  });

  describe('getApparatusOosHistory', () => {
    it('fans out over the department apparatus roster and returns OOS records within the period (AC1)', async () => {
      const deptId = freshDeptId();
      await client.send(
        new PutCommand({
          TableName: PLATFORM_TABLE,
          Item: {
            pk: buildDeptScopedPk(deptId, 'APPARATUS', 'APP-ENGINE-2'),
            sk: 'METADATA',
            gsi3pk: buildDeptScopedPk(deptId, 'APPARATUS'),
            apparatusId: 'APP-ENGINE-2',
            unitId: 'ENGINE-2',
            status: 'OUT_OF_SERVICE',
          },
        }),
      );
      await client.send(
        new PutCommand({
          TableName: PLATFORM_TABLE,
          Item: {
            pk: buildDeptScopedPk(deptId, 'APPARATUS', 'APP-ENGINE-2'),
            sk: 'OOS#1700500000',
            entityType: 'OUT_OF_SERVICE_RECORD',
            reason: 'brakes',
            startAt: 1_700_500_000,
            endAt: null,
          },
        }),
      );

      const result = await getApparatusOosHistory(client, config, deptId, PERIOD);

      expect(result).toEqual({
        records: [{ unitId: 'ENGINE-2', reason: 'brakes', startAt: 1_700_500_000, endAt: null }],
        totalOutOfServiceEvents: 1,
      });
    });

    it('includes a record that started before the period and is still open — interval overlap, not startAt-only (P8/AC1)', async () => {
      const deptId = freshDeptId();
      await client.send(
        new PutCommand({
          TableName: PLATFORM_TABLE,
          Item: {
            pk: buildDeptScopedPk(deptId, 'APPARATUS', 'APP-ENGINE-1'),
            sk: 'METADATA',
            gsi3pk: buildDeptScopedPk(deptId, 'APPARATUS'),
            apparatusId: 'APP-ENGINE-1',
            unitId: 'ENGINE-1',
            status: 'OUT_OF_SERVICE',
          },
        }),
      );
      await client.send(
        new PutCommand({
          TableName: PLATFORM_TABLE,
          Item: {
            pk: buildDeptScopedPk(deptId, 'APPARATUS', 'APP-ENGINE-1'),
            sk: 'OOS#1699000000',
            entityType: 'OUT_OF_SERVICE_RECORD',
            reason: 'transmission',
            startAt: 1_699_000_000,
            endAt: null,
          },
        }),
      );

      const result = await getApparatusOosHistory(client, config, deptId, PERIOD);

      expect(result.totalOutOfServiceEvents).toBe(1);
      expect(result.records[0]).toMatchObject({ unitId: 'ENGINE-1', reason: 'transmission' });
    });

    it('includes a record that started before the period and ended inside it (P8/AC1)', async () => {
      const deptId = freshDeptId();
      await client.send(
        new PutCommand({
          TableName: PLATFORM_TABLE,
          Item: {
            pk: buildDeptScopedPk(deptId, 'APPARATUS', 'APP-LADDER-1'),
            sk: 'METADATA',
            gsi3pk: buildDeptScopedPk(deptId, 'APPARATUS'),
            apparatusId: 'APP-LADDER-1',
            unitId: 'LADDER-1',
            status: 'IN_SERVICE',
          },
        }),
      );
      await client.send(
        new PutCommand({
          TableName: PLATFORM_TABLE,
          Item: {
            pk: buildDeptScopedPk(deptId, 'APPARATUS', 'APP-LADDER-1'),
            sk: 'OOS#1699000000',
            entityType: 'OUT_OF_SERVICE_RECORD',
            reason: 'pump repair',
            startAt: 1_699_000_000,
            endAt: 1_700_100_000,
          },
        }),
      );

      const result = await getApparatusOosHistory(client, config, deptId, PERIOD);

      expect(result.totalOutOfServiceEvents).toBe(1);
    });

    it('excludes a record that both started and ended before the period', async () => {
      const deptId = freshDeptId();
      await client.send(
        new PutCommand({
          TableName: PLATFORM_TABLE,
          Item: {
            pk: buildDeptScopedPk(deptId, 'APPARATUS', 'APP-RESCUE-1'),
            sk: 'METADATA',
            gsi3pk: buildDeptScopedPk(deptId, 'APPARATUS'),
            apparatusId: 'APP-RESCUE-1',
            unitId: 'RESCUE-1',
            status: 'IN_SERVICE',
          },
        }),
      );
      await client.send(
        new PutCommand({
          TableName: PLATFORM_TABLE,
          Item: {
            pk: buildDeptScopedPk(deptId, 'APPARATUS', 'APP-RESCUE-1'),
            sk: 'OOS#1699000000',
            entityType: 'OUT_OF_SERVICE_RECORD',
            reason: 'brakes',
            startAt: 1_699_000_000,
            endAt: 1_699_100_000,
          },
        }),
      );

      const result = await getApparatusOosHistory(client, config, deptId, PERIOD);

      expect(result).toEqual({ records: [], totalOutOfServiceEvents: 0 });
    });

    it('returns a zero-value result when the department has no apparatus yet', async () => {
      const deptId = freshDeptId();

      const result = await getApparatusOosHistory(client, config, deptId, PERIOD);

      expect(result).toEqual({ records: [], totalOutOfServiceEvents: 0 });
    });

    it('logs the original error and rethrows when a Query fails (error-path-logging)', async () => {
      const deptId = freshDeptId();
      const badConfig: GrantsReportConfig = { ...config, platformTableName: 'no-such-table' };

      await expect(getApparatusOosHistory(client, badConfig, deptId, PERIOD)).rejects.toThrow();
    });
  });
});
