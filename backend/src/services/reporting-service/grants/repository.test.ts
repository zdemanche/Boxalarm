import { describe, expect, it, vi } from 'vitest';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import type { GrantsReportConfig } from '../client.js';
import {
  getActiveMemberCountAndTrend,
  getApparatusOosHistory,
  getTrainingHoursCompliance,
} from './repository.js';

const DEPT_ID = 'dept-001' as VerifiedDeptId;
const CONFIG: GrantsReportConfig = {
  personnelTableName: 'personnel-table',
  trainingTableName: 'training-table',
  platformTableName: 'platform-table',
};
const PERIOD = { periodStart: 1_700_000_000_000, periodEnd: 1_701_000_000_000 };

function routedClient(
  router: (command: QueryCommand) => readonly Record<string, unknown>[] | Error,
): DynamoDBDocumentClient {
  const send = vi.fn((command: unknown) => {
    if (!(command instanceof QueryCommand)) {
      return Promise.reject(new Error('unexpected command'));
    }
    const result = router(command);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve({ Items: result });
  });
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('getActiveMemberCountAndTrend', () => {
  it('counts ACTIVE members and members who joined within the period (AC1)', async () => {
    const client = routedClient(() => [
      { status: 'ACTIVE', joinDate: '2023-11-20' },
      { status: 'ACTIVE', joinDate: '2020-01-01' },
      { status: 'RETIRED', joinDate: '2020-01-01' },
    ]);

    const result = await getActiveMemberCountAndTrend(client, CONFIG, DEPT_ID, PERIOD);

    expect(result).toEqual({ activeMemberCount: 2, joinedInPeriod: 1 });
  });

  it('excludes a member with a malformed joinDate from joinedInPeriod rather than throwing (routine-input row)', async () => {
    const client = routedClient(() => [{ status: 'ACTIVE', joinDate: 'not-a-date' }]);

    const result = await getActiveMemberCountAndTrend(client, CONFIG, DEPT_ID, PERIOD);

    expect(result.joinedInPeriod).toBe(0);
  });

  it('logs the original error and rethrows when the roster Query fails (error-path-logging)', async () => {
    const client = routedClient(() => new Error('roster table throttled'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(getActiveMemberCountAndTrend(client, CONFIG, DEPT_ID, PERIOD)).rejects.toThrow(
      'roster table throttled',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('reporting.grants.memberCount.failed'),
    );
    errorSpy.mockRestore();
  });
});

describe('getTrainingHoursCompliance', () => {
  it('sums attendee hours for events within the period only (AC1)', async () => {
    let call = 0;
    const client = routedClient((command) => {
      call += 1;
      if (call === 1) {
        return [
          { eventId: 'EVT-1', startAt: 1_700_500_000_000 },
          { eventId: 'EVT-2', startAt: 1_699_000_000_000 },
        ];
      }
      const pk = command.input.ExpressionAttributeValues?.[':pk'] as unknown;
      if (pk === buildDeptScopedPk(DEPT_ID, 'TRAINING_EVENT', 'EVT-1')) {
        return [
          { memberId: 'MBR-1', hours: 4 },
          { memberId: 'MBR-2', hours: 2 },
        ];
      }
      return [];
    });

    const result = await getTrainingHoursCompliance(client, CONFIG, DEPT_ID, PERIOD);

    expect(result).toEqual({ totalHours: 6, memberCount: 2, eventCount: 1 });
  });

  it('treats a missing/non-numeric/negative hours value as 0 rather than throwing (routine-input row)', async () => {
    let call = 0;
    const client = routedClient(() => {
      call += 1;
      if (call === 1) {
        return [{ eventId: 'EVT-1', startAt: 1_700_500_000_000 }];
      }
      return [
        { memberId: 'MBR-1', hours: Number.NaN },
        { memberId: 'MBR-2', hours: -3 },
        { memberId: 'MBR-3' },
      ];
    });

    const result = await getTrainingHoursCompliance(client, CONFIG, DEPT_ID, PERIOD);

    expect(result.totalHours).toBe(0);
    expect(result.memberCount).toBe(3);
  });

  it('logs the original error and rethrows when a Query fails (error-path-logging)', async () => {
    const client = routedClient(() => new Error('training table unavailable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(getTrainingHoursCompliance(client, CONFIG, DEPT_ID, PERIOD)).rejects.toThrow(
      'training table unavailable',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('reporting.grants.trainingHours.failed'),
    );
    errorSpy.mockRestore();
  });
});

describe('getApparatusOosHistory', () => {
  it('fans out over the department apparatus roster and returns OOS records within the period (AC1)', async () => {
    let call = 0;
    const client = routedClient((command) => {
      call += 1;
      if (call === 1) {
        return [{ apparatusId: 'APP-ENGINE-2', unitId: 'ENGINE-2', status: 'OUT_OF_SERVICE' }];
      }
      const pk = command.input.ExpressionAttributeValues?.[':pk'] as unknown;
      if (pk === buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-ENGINE-2')) {
        return [{ reason: 'brakes', startAt: 1_700_500_000, endAt: null }];
      }
      return [];
    });

    const result = await getApparatusOosHistory(client, CONFIG, DEPT_ID, PERIOD);

    expect(result).toEqual({
      records: [{ unitId: 'ENGINE-2', reason: 'brakes', startAt: 1_700_500_000, endAt: null }],
      totalOutOfServiceEvents: 1,
    });
  });

  it('excludes OOS records outside the requested period', async () => {
    let call = 0;
    const client = routedClient(() => {
      call += 1;
      if (call === 1) {
        return [{ apparatusId: 'APP-ENGINE-2', unitId: 'ENGINE-2', status: 'IN_SERVICE' }];
      }
      return [{ reason: 'brakes', startAt: 1_699_000_000, endAt: 1_699_100_000 }];
    });

    const result = await getApparatusOosHistory(client, CONFIG, DEPT_ID, PERIOD);

    expect(result).toEqual({ records: [], totalOutOfServiceEvents: 0 });
  });

  it('logs the original error and rethrows when a Query fails (error-path-logging)', async () => {
    const client = routedClient(() => new Error('platform table unavailable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(getApparatusOosHistory(client, CONFIG, DEPT_ID, PERIOD)).rejects.toThrow(
      'platform table unavailable',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('reporting.grants.apparatusOos.failed'),
    );
    errorSpy.mockRestore();
  });
});
