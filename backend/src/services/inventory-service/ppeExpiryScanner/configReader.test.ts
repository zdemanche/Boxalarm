import { describe, expect, it, vi } from 'vitest';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  DEFAULT_PPE_EXPIRY_LEAD_DAYS,
  monthPartitionsForScan,
  readPpeExpiryLeadDays,
  selectWithinLeadTime,
} from './configReader.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const env = { PLATFORM_CONFIG_DYNAMO_TABLE_NAME: 'platform-config' };

function fakeClient(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('readPpeExpiryLeadDays', () => {
  it('reads value.ppeExpiryLeadDays from CONFIG#ALERT_RULES', async () => {
    const send = vi.fn().mockResolvedValue({ Item: { value: { ppeExpiryLeadDays: 45 } } });
    const client = fakeClient(send);

    const leadDays = await readPpeExpiryLeadDays(client, env, deptId, 'trace-1');

    expect(leadDays).toBe(45);
    const command = send.mock.calls[0]?.[0] as GetCommand;
    expect(command.input.Key).toEqual({ pk: 'DEPT#NICHOLS', sk: 'CONFIG#ALERT_RULES' });
  });

  it('falls back to the default when no config is set (AC2, never skips the department)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = fakeClient(send);

    const leadDays = await readPpeExpiryLeadDays(client, env, deptId, 'trace-2');

    expect(leadDays).toBe(DEFAULT_PPE_EXPIRY_LEAD_DAYS);
  });

  it('logs the original error and rethrows on a read failure', async () => {
    const failure = new Error('DynamoDB unavailable');
    const send = vi.fn().mockRejectedValue(failure);
    const client = fakeClient(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(readPpeExpiryLeadDays(client, env, deptId, 'trace-3')).rejects.toBe(failure);

    const logged = errorSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === 'ppeExpiryScanner.config.read_failed');
    expect(logged?.correlationId).toBe('trace-3');
    errorSpy.mockRestore();
  });
});

describe('monthPartitionsForScan', () => {
  it('returns a single month when the lead window does not cross a month boundary', () => {
    const months = monthPartitionsForScan(new Date('2026-09-05T00:00:00Z'), 10);
    expect(months).toEqual(['2026-09']);
  });

  it('returns two months when the lead window crosses into the next month', () => {
    const months = monthPartitionsForScan(new Date('2026-09-25T00:00:00Z'), 10);
    expect(months).toEqual(['2026-09', '2026-10']);
  });
});

describe('selectWithinLeadTime', () => {
  const now = new Date('2026-09-14T00:00:00Z');

  it('keeps records within [0, leadDays] and drops records outside the window', () => {
    const result = selectWithinLeadTime(
      [{ expiryDate: '2026-09-24' }, { expiryDate: '2026-10-20' }, { expiryDate: '2026-09-01' }],
      now,
      10,
    );
    expect(result).toEqual([{ expiryDate: '2026-09-24' }]);
  });

  it('drops a record with a malformed expiryDate rather than throwing', () => {
    const result = selectWithinLeadTime([{ expiryDate: 'not-a-date' }], now, 10);
    expect(result).toEqual([]);
  });
});
