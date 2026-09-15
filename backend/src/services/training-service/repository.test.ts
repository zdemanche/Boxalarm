import { describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  createSignupAttendance,
  createTrainingEvent,
  DuplicateSignupError,
  getTrainingEvent,
  listMemberAttendanceEventIds,
  listMemberAttendanceRecords,
  listTrainingEvents,
  recordAttendanceHours,
} from './repository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-001' });
const CONFIG = { tableName: 'platform-table' };
const EVENT = { eventId: 'e1', title: 't', category: 'ems', startAt: 1_000, endAt: 2_000 };

function fakeClient(sendImpl: (command: unknown) => unknown): DynamoDBDocumentClient {
  return { send: vi.fn(sendImpl) } as unknown as DynamoDBDocumentClient;
}

describe('createTrainingEvent', () => {
  it('writes a department-scoped TRAINING_EVENT item with GSI3 attributes derived from startAt (AC1)', async () => {
    let captured: { input: Record<string, unknown> } | undefined;
    const client = fakeClient((command) => {
      captured = command as { input: Record<string, unknown> };
      return {};
    });

    const result = await createTrainingEvent(client, CONFIG, DEPT_ID, {
      title: 'Ladder Ops',
      category: 'fireground',
      startAt: 1_000,
      endAt: 2_000,
    });

    expect(result.title).toBe('Ladder Ops');
    const item = captured!.input.Item as Record<string, unknown>;
    expect(item.pk).toBe(`DEPT#dept-001#TRAINING_EVENT#${result.eventId}`);
    expect(item.sk).toBe('METADATA');
    expect(item.gsi3pk).toBe('DEPT#dept-001#TRAINING_EVENT');
    expect(item.gsi3sk).toBe('1000');
    expect(captured!.input.ConditionExpression).toBe('attribute_not_exists(pk)');
  });
});

describe('listTrainingEvents', () => {
  it('queries GSI3 ascending by start time, paged via LastEvaluatedKey, mapped back to TrainingEvent (AC1)', async () => {
    let captured: { input: Record<string, unknown> } | undefined;
    let callCount = 0;
    const client = fakeClient((command) => {
      captured = command as { input: Record<string, unknown> };
      callCount += 1;
      if (callCount === 1) {
        return {
          Items: [{ eventId: 'e1', title: 'Drill 1', category: 'ems', startAt: 100, endAt: 200 }],
          LastEvaluatedKey: { pk: 'p1', sk: 's1' },
        };
      }
      return {
        Items: [{ eventId: 'e2', title: 'Drill 2', category: 'ems', startAt: 300, endAt: 400 }],
      };
    });

    const events = await listTrainingEvents(client, CONFIG, DEPT_ID);

    expect(callCount).toBe(2);
    expect(captured!.input.IndexName).toBe('GSI3');
    expect(captured!.input.ScanIndexForward).toBe(true);
    expect(captured!.input.Limit).toBeGreaterThan(0);
    expect(captured!.input.ExpressionAttributeValues).toEqual({
      ':gsi3pk': 'DEPT#dept-001#TRAINING_EVENT',
    });
    expect(events.map((e) => e.eventId)).toEqual(['e1', 'e2']);
  });
});

describe('getTrainingEvent', () => {
  it('returns undefined when no item is found', async () => {
    const client = fakeClient(() => ({}));
    expect(await getTrainingEvent(client, CONFIG, DEPT_ID, 'missing')).toBeUndefined();
  });
});

describe('listMemberAttendanceEventIds', () => {
  it('queries GSI1 for MEMBER#{memberId} attendance items, projected to eventId, paged via LastEvaluatedKey', async () => {
    let captured: { input: Record<string, unknown> } | undefined;
    let callCount = 0;
    const client = fakeClient((command) => {
      captured = command as { input: Record<string, unknown> };
      callCount += 1;
      if (callCount === 1) {
        return { Items: [{ eventId: 'e1' }], LastEvaluatedKey: { gsi1pk: 'p', gsi1sk: 's' } };
      }
      return { Items: [{ eventId: 'e2' }] };
    });

    const ids = await listMemberAttendanceEventIds(client, CONFIG, 'member-1');

    expect(callCount).toBe(2);
    expect(captured!.input.IndexName).toBe('GSI1');
    expect(captured!.input.KeyConditionExpression).toBe(
      'gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)',
    );
    expect(captured!.input.ExpressionAttributeValues).toEqual({
      ':gsi1pk': 'MEMBER#member-1',
      ':prefix': 'TRAINING_ATTENDANCE#',
    });
    expect(captured!.input.ProjectionExpression).toBe('eventId');
    expect(ids).toEqual(new Set(['e1', 'e2']));
  });
});

describe('listMemberAttendanceRecords', () => {
  it('queries GSI1 for MEMBER#{memberId} attendance, projecting hours/category/gsi1sk, across multiple categories and pages (AC1)', async () => {
    let callCount = 0;
    const client = fakeClient(() => {
      callCount += 1;
      if (callCount === 1) {
        return {
          Items: [
            { eventId: 'e1', category: 'LADDER_OPS', hours: 3, gsi1sk: 'TRAINING_ATTENDANCE#100' },
          ],
          LastEvaluatedKey: { gsi1pk: 'p', gsi1sk: 's' },
        };
      }
      return {
        Items: [{ eventId: 'e2', category: 'EMS', hours: 2, gsi1sk: 'TRAINING_ATTENDANCE#200' }],
      };
    });

    const records = await listMemberAttendanceRecords(client, CONFIG, 'member-1');

    expect(callCount).toBe(2);
    expect(records).toEqual([
      { eventId: 'e1', category: 'LADDER_OPS', hours: 3, startAt: 100 },
      { eventId: 'e2', category: 'EMS', hours: 2, startAt: 200 },
    ]);
  });

  it('defaults hours to 0 for a signed-up-but-not-yet-recorded attendance record', async () => {
    const client = fakeClient(() => ({
      Items: [{ eventId: 'e1', category: 'LADDER_OPS', gsi1sk: 'TRAINING_ATTENDANCE#100' }],
    }));

    const records = await listMemberAttendanceRecords(client, CONFIG, 'member-1');

    expect(records).toEqual([{ eventId: 'e1', category: 'LADDER_OPS', hours: 0, startAt: 100 }]);
  });

  it('returns an empty array for a member with no attendance history (AC3)', async () => {
    const client = fakeClient(() => ({}));

    const records = await listMemberAttendanceRecords(client, CONFIG, 'member-1');

    expect(records).toEqual([]);
  });
});

describe('createSignupAttendance', () => {
  it('writes a TRAINING_ATTENDANCE item denormalizing category and building gsi1pk/gsi1sk from the event (AC2/AC3)', async () => {
    let captured: { input: Record<string, unknown> } | undefined;
    const client = fakeClient((command) => {
      captured = command as { input: Record<string, unknown> };
      return {};
    });

    await createSignupAttendance(client, CONFIG, DEPT_ID, EVENT, 'member-1');

    const item = captured!.input.Item as Record<string, unknown>;
    expect(item.pk).toBe('DEPT#dept-001#TRAINING_EVENT#e1');
    expect(item.sk).toBe('ATTENDEE#member-1');
    expect(item.category).toBe('ems');
    expect(item.gsi1pk).toBe('MEMBER#member-1');
    expect(item.gsi1sk).toBe('TRAINING_ATTENDANCE#1000');
    expect(item.hours).toBeUndefined();
  });

  it('throws DuplicateSignupError, logging the original ConditionalCheckFailedException first, on a repeat signup (409 row)', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakeClient(() => {
      throw new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });
    });

    await expect(
      createSignupAttendance(client, CONFIG, DEPT_ID, EVENT, 'member-1'),
    ).rejects.toThrow(DuplicateSignupError);
    expect(logSpy.mock.calls[0]?.[0] as string).toContain('ConditionalCheckFailedException');
    logSpy.mockRestore();
  });
});

describe('recordAttendanceHours', () => {
  it('uses TransactWriteItems (never BatchWriteItem) with one upsert Update per attendee, including a walk-in never signed up (AC3)', async () => {
    let captured: { input: Record<string, unknown> } | undefined;
    const client = fakeClient((command) => {
      captured = command as { input: Record<string, unknown> };
      return {};
    });

    await recordAttendanceHours(client, CONFIG, DEPT_ID, EVENT, [
      { memberId: 'member-1', hours: 2 },
      { memberId: 'never-signed-up', hours: 3 },
    ]);

    const items = captured!.input.TransactItems as Array<{ Update: Record<string, unknown> }>;
    expect(items).toHaveLength(2);
    expect(items[0]!.Update.ConditionExpression).toBeUndefined();
    expect(items[0]!.Update.Key).toEqual({
      pk: 'DEPT#dept-001#TRAINING_EVENT#e1',
      sk: 'ATTENDEE#member-1',
    });
    expect(items[1]!.Update.ExpressionAttributeValues).toEqual({
      ':hours': 3,
      ':entityType': 'TRAINING_ATTENDANCE',
      ':eventId': 'e1',
      ':memberId': 'never-signed-up',
      ':category': 'ems',
      ':gsi1pk': 'MEMBER#never-signed-up',
      ':gsi1sk': 'TRAINING_ATTENDANCE#1000',
    });
  });

  it('logs the original error then rethrows an unrelated TransactWriteItems failure without swallowing it', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakeClient(() => {
      throw new Error('DynamoDB unavailable');
    });

    await expect(
      recordAttendanceHours(client, CONFIG, DEPT_ID, EVENT, [{ memberId: 'm1', hours: 1 }]),
    ).rejects.toThrow('DynamoDB unavailable');
    expect(logSpy.mock.calls[0]?.[0] as string).toContain('DynamoDB unavailable');
    logSpy.mockRestore();
  });
});
