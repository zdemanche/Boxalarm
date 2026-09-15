import { describe, expect, it, vi } from 'vitest';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  DEFAULT_APPARATUS_TEST_LEAD_DAYS,
  monthPartitionsForScan,
  readApparatusTestLeadDays,
  selectWithinLeadTime,
} from './configReader.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const env = { PLATFORM_TABLE_NAME: 'platform-service' };

function fakeClient(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('readApparatusTestLeadDays', () => {
  it('reads value.apparatusTestLeadDays from DEPT#{deptId}/CONFIG#ALERT_RULES via GetItem (AC2)', async () => {
    const send = vi.fn().mockResolvedValue({ Item: { value: { apparatusTestLeadDays: 45 } } });
    const client = fakeClient(send);

    const leadDays = await readApparatusTestLeadDays(client, env, deptId, 'trace-1');

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as GetCommand;
    expect(command).toBeInstanceOf(GetCommand);
    expect(command.input.Key).toEqual({ pk: 'DEPT#NICHOLS', sk: 'CONFIG#ALERT_RULES' });
    expect(leadDays).toBe(45);
  });

  it('falls back to the documented default when the config item is absent', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = fakeClient(send);

    const leadDays = await readApparatusTestLeadDays(client, env, deptId, 'trace-2');

    expect(leadDays).toBe(DEFAULT_APPARATUS_TEST_LEAD_DAYS);
  });

  it('falls back to the default when apparatusTestLeadDays is non-numeric/NaN/null', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: { value: { apparatusTestLeadDays: 'thirty' } } })
      .mockResolvedValueOnce({ Item: { value: { apparatusTestLeadDays: Number.NaN } } })
      .mockResolvedValueOnce({ Item: { value: { apparatusTestLeadDays: null } } });
    const client = fakeClient(send);

    for (let i = 0; i < 3; i += 1) {
      expect(await readApparatusTestLeadDays(client, env, deptId, `trace-${i}`)).toBe(
        DEFAULT_APPARATUS_TEST_LEAD_DAYS,
      );
    }
  });

  it('logs the original error and rethrows on a dependency failure (fail-closed)', async () => {
    const failure = new Error('DynamoDB unavailable');
    const send = vi.fn().mockRejectedValue(failure);
    const client = fakeClient(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(readApparatusTestLeadDays(client, env, deptId, 'trace-9')).rejects.toBe(failure);

    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.event).toBe('testDueScanner.config.read_failed');
    expect(logged.correlationId).toBe('trace-9');
    errorSpy.mockRestore();
  });

  it('throws (fail-closed) when PLATFORM_TABLE_NAME is not set', async () => {
    const send = vi.fn();
    const client = fakeClient(send);

    await expect(readApparatusTestLeadDays(client, {}, deptId, 'trace-10')).rejects.toThrow(
      'PLATFORM_TABLE_NAME',
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe('monthPartitionsForScan', () => {
  it('returns the current and next YYYY-MM partitions for the default 30-day lead time', () => {
    expect(monthPartitionsForScan(new Date('2026-09-14T12:00:00Z'), 30)).toEqual([
      '2026-09',
      '2026-10',
    ]);
  });

  it('returns only the current month for a zero-day lead time', () => {
    expect(monthPartitionsForScan(new Date('2026-09-14T00:00:00Z'), 0)).toEqual(['2026-09']);
  });
});

interface FakeRecord {
  readonly apparatusId: string;
  readonly dueDate: string;
}

describe('selectWithinLeadTime', () => {
  const now = new Date('2026-09-14T00:00:00Z');

  it('includes a record exactly at the lead-time boundary', () => {
    const records: FakeRecord[] = [{ apparatusId: 'APP-1', dueDate: '2026-10-14' }];
    expect(selectWithinLeadTime(records, now, 30)).toEqual(records);
  });

  it('excludes a record one day beyond the lead-time boundary', () => {
    const records: FakeRecord[] = [{ apparatusId: 'APP-1', dueDate: '2026-10-15' }];
    expect(selectWithinLeadTime(records, now, 30)).toEqual([]);
  });

  it('excludes a record that already lapsed yesterday', () => {
    const records: FakeRecord[] = [{ apparatusId: 'APP-1', dueDate: '2026-09-13' }];
    expect(selectWithinLeadTime(records, now, 30)).toEqual([]);
  });

  it('excludes a record with a malformed dueDate rather than crashing', () => {
    const records: FakeRecord[] = [{ apparatusId: 'APP-1', dueDate: 'not-a-date' }];
    expect(selectWithinLeadTime(records, now, 30)).toEqual([]);
  });
});
