import { describe, expect, it, vi } from 'vitest';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  DEFAULT_CERT_EXPIRY_LEAD_DAYS,
  monthPartitionsForScan,
  readCertExpiryLeadDays,
  selectWithinLeadTime,
} from './configReader.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const env = { PLATFORM_CONFIG_DYNAMO_TABLE_NAME: 'platform-service' };

function fakeClient(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('readCertExpiryLeadDays', () => {
  it('reads value.certExpiryLeadDays from DEPT#{deptId}/CONFIG#ALERT_RULES via GetItem (AC1)', async () => {
    const send = vi.fn().mockResolvedValue({ Item: { value: { certExpiryLeadDays: 45 } } });
    const client = fakeClient(send);

    const leadDays = await readCertExpiryLeadDays(client, env, deptId, 'trace-1');

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as GetCommand;
    expect(command).toBeInstanceOf(GetCommand);
    expect(command.input.Key).toEqual({ pk: 'DEPT#NICHOLS', sk: 'CONFIG#ALERT_RULES' });
    expect(leadDays).toBe(45);
  });

  it('falls back to the documented default when the config item is absent (AC4)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = fakeClient(send);

    const leadDays = await readCertExpiryLeadDays(client, env, deptId, 'trace-2');

    expect(leadDays).toBe(DEFAULT_CERT_EXPIRY_LEAD_DAYS);
  });

  it('falls back to the default when certExpiryLeadDays is a non-numeric/NaN/null value', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: { value: { certExpiryLeadDays: 'thirty' } } })
      .mockResolvedValueOnce({ Item: { value: { certExpiryLeadDays: Number.NaN } } })
      .mockResolvedValueOnce({ Item: { value: { certExpiryLeadDays: null } } })
      .mockResolvedValueOnce({ Item: { value: {} } });
    const client = fakeClient(send);

    for (let i = 0; i < 4; i += 1) {
      expect(await readCertExpiryLeadDays(client, env, deptId, `trace-${i}`)).toBe(
        DEFAULT_CERT_EXPIRY_LEAD_DAYS,
      );
    }
  });

  it('logs the original error and rethrows on a dependency failure (fail-closed, never a silent default)', async () => {
    const failure = new Error('DynamoDB unavailable');
    const send = vi.fn().mockRejectedValue(failure);
    const client = fakeClient(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(readCertExpiryLeadDays(client, env, deptId, 'trace-9')).rejects.toBe(failure);

    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.event).toBe('certificationExpiryScanner.config.read_failed');
    expect(logged.correlationId).toBe('trace-9');
    errorSpy.mockRestore();
  });

  it('throws (fail-closed) when PLATFORM_CONFIG_DYNAMO_TABLE_NAME is not set', async () => {
    const send = vi.fn();
    const client = fakeClient(send);

    await expect(readCertExpiryLeadDays(client, {}, deptId, 'trace-10')).rejects.toThrow(
      'PLATFORM_CONFIG_DYNAMO_TABLE_NAME',
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe('monthPartitionsForScan', () => {
  it('returns the current and next YYYY-MM partitions for the default 30-day lead time (AC1)', () => {
    expect(monthPartitionsForScan(new Date('2026-09-14T12:00:00Z'), 30)).toEqual([
      '2026-09',
      '2026-10',
    ]);
  });

  it('rolls the next partition into January of the following year at a December boundary', () => {
    expect(monthPartitionsForScan(new Date('2026-12-20T00:00:00Z'), 30)).toEqual([
      '2026-12',
      '2027-01',
    ]);
  });

  it('extends past two months when a configured lead time reaches further out (regression: 60-day lead time)', () => {
    expect(monthPartitionsForScan(new Date('2026-09-14T00:00:00Z'), 60)).toEqual([
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
  });

  it('returns only the current month for a zero-day lead time', () => {
    expect(monthPartitionsForScan(new Date('2026-09-14T00:00:00Z'), 0)).toEqual(['2026-09']);
  });
});

interface FakeRecord {
  readonly certId: string;
  readonly expiryDate: string;
}

describe('selectWithinLeadTime', () => {
  const now = new Date('2026-09-14T00:00:00Z');

  it('includes a record exactly at the lead-time boundary', () => {
    const records: FakeRecord[] = [{ certId: 'CERT-1', expiryDate: '2026-10-14' }];
    expect(selectWithinLeadTime(records, now, 30)).toEqual(records);
  });

  it('excludes a record one day beyond the lead-time boundary', () => {
    const records: FakeRecord[] = [{ certId: 'CERT-1', expiryDate: '2026-10-15' }];
    expect(selectWithinLeadTime(records, now, 30)).toEqual([]);
  });

  it('includes a record due today (0 days out)', () => {
    const records: FakeRecord[] = [{ certId: 'CERT-1', expiryDate: '2026-09-14' }];
    expect(selectWithinLeadTime(records, now, 30)).toEqual(records);
  });

  it('excludes a record that already expired yesterday', () => {
    const records: FakeRecord[] = [{ certId: 'CERT-1', expiryDate: '2026-09-13' }];
    expect(selectWithinLeadTime(records, now, 30)).toEqual([]);
  });

  it('excludes a record with a malformed expiryDate rather than crashing', () => {
    const records: FakeRecord[] = [{ certId: 'CERT-1', expiryDate: 'not-a-date' }];
    expect(selectWithinLeadTime(records, now, 30)).toEqual([]);
  });
});
