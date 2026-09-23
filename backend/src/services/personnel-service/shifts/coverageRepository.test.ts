import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { buildDutyShift, buildMemberQualification, buildShiftPosition } from './testFixtures.js';
import { buildEligibleQualCodeIndex, fetchDeptShiftsWithPositions } from './coverageRepository.js';

const TABLE_NAME = 'personnel-coverage-test';
const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

describe('coverageRepository (real DynamoDB via LocalStack)', () => {
  let container: StartedLocalStackContainer;
  let client: DynamoDBDocumentClient;

  beforeAll(async () => {
    container = await new LocalstackContainer('localstack/localstack:4').start();
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ENDPOINT_URL = container.getConnectionUri();
    const base = new DynamoDBClient({
      endpoint: container.getConnectionUri(),
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await base.send(
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
    client = DynamoDBDocumentClient.from(base);
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  function memberItem(deptId: typeof DEPT_ID, memberId: string) {
    return {
      pk: buildDeptScopedPk(deptId, 'MEMBER', memberId),
      sk: 'METADATA',
      entityType: 'MEMBER',
      memberId,
      gsi3pk: buildDeptScopedPk(deptId, 'MEMBER'),
      gsi3sk: `Lastname#${memberId}`,
    };
  }

  async function put(item: Record<string, unknown>): Promise<void> {
    await client.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  }

  describe('fetchDeptShiftsWithPositions', () => {
    it('returns an upcoming shift with its positions, excluding a CANCELLED shift and a past shift (AC1, AC2)', async () => {
      const now = Date.now();
      const upcomingShiftId = `upcoming-${now}`;
      const cancelledShiftId = `cancelled-${now}`;
      const pastShiftId = `past-${now}`;

      await put(
        buildDutyShift(DEPT_ID, upcomingShiftId, {
          startAt: now + 3_600_000,
          endAt: now + 7_200_000,
          status: 'OPEN',
        }),
      );
      await put(
        buildShiftPosition(DEPT_ID, upcomingShiftId, 'DRIVER', {
          requiredQual: 'DRIVER_OPERATOR',
          claimedByMemberId: 'member-1',
        }),
      );
      await put(buildShiftPosition(DEPT_ID, upcomingShiftId, 'FF1'));

      await put(
        buildDutyShift(DEPT_ID, cancelledShiftId, {
          startAt: now + 3_600_000,
          endAt: now + 7_200_000,
          status: 'CANCELLED',
        }),
      );
      await put(buildShiftPosition(DEPT_ID, cancelledShiftId, 'DRIVER'));

      await put(
        buildDutyShift(DEPT_ID, pastShiftId, {
          startAt: now - 7_200_000,
          endAt: now - 3_600_000,
          status: 'FULL',
        }),
      );
      await put(buildShiftPosition(DEPT_ID, pastShiftId, 'DRIVER'));

      const shifts = await fetchDeptShiftsWithPositions(client, TABLE_NAME, DEPT_ID);

      expect(shifts.map((shift) => shift.shiftId)).toEqual([upcomingShiftId]);
      expect(shifts[0]?.positions).toEqual([
        { positionCode: 'DRIVER', requiredQual: 'DRIVER_OPERATOR', claimedByMemberId: 'member-1' },
        { positionCode: 'FF1' },
      ]);
    });

    it('returns an empty array when the department has no shifts', async () => {
      const emptyDeptId = toVerifiedDeptId({ deptId: `EMPTY-${Date.now()}` });
      const shifts = await fetchDeptShiftsWithPositions(client, TABLE_NAME, emptyDeptId);
      expect(shifts).toEqual([]);
    });
  });

  describe('buildEligibleQualCodeIndex', () => {
    it('collects only currently-eligible qualCodes across the dept roster (real GSI3 query)', async () => {
      const rosterDeptId = toVerifiedDeptId({ deptId: `ROSTER-${Date.now()}` });
      await put(memberItem(rosterDeptId, 'member-1'));
      await put(memberItem(rosterDeptId, 'member-2'));
      await put(
        buildMemberQualification(rosterDeptId, 'member-1', 'DRIVER_OPERATOR', {
          currentlyEligible: true,
        }),
      );
      await put(
        buildMemberQualification(rosterDeptId, 'member-2', 'OFFICER_CERT', {
          currentlyEligible: false,
        }),
      );

      const eligibleQualCodes = await buildEligibleQualCodeIndex(
        client,
        TABLE_NAME,
        rosterDeptId,
        'corr-1',
      );

      expect(eligibleQualCodes.has('DRIVER_OPERATOR')).toBe(true);
      expect(eligibleQualCodes.has('OFFICER_CERT')).toBe(false);
    });

    it('returns an empty set when the dept roster has zero members', async () => {
      const emptyDeptId = toVerifiedDeptId({ deptId: `NOMEMBERS-${Date.now()}` });
      const eligibleQualCodes = await buildEligibleQualCodeIndex(
        client,
        TABLE_NAME,
        emptyDeptId,
        'corr-2',
      );
      expect(eligibleQualCodes.size).toBe(0);
    });

    it('emits an alarmable metric alongside the warn log when the dept roster has zero members (V2)', async () => {
      const emptyDeptId = toVerifiedDeptId({ deptId: `NOMEMBERS-METRIC-${Date.now()}` });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      let emittedMetric = false;
      try {
        await buildEligibleQualCodeIndex(client, TABLE_NAME, emptyDeptId, 'corr-3');
        emittedMetric = logSpy.mock.calls.some(([line]) =>
          String(line).includes('ShiftCoverageEmptyRoster'),
        );
      } finally {
        logSpy.mockRestore();
      }
      expect(emittedMetric).toBe(true);
    });
  });
});
