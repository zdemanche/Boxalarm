import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { getDepartmentTimeZone, getLosapYear, zonedYear } from './departmentYear.js';
import { LosapRepositoryUnavailableError } from './repository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const NEW_YEARS_EVE_2130_EST = Date.parse('2026-12-31T21:30:00-05:00') / 1000;

function fakeClient(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('zonedYear', () => {
  it("counts a New Year's Eve evening call in the year it happened locally, not the UTC year", () => {
    expect(zonedYear(NEW_YEARS_EVE_2130_EST, 'America/New_York')).toBe(2026);
    expect(zonedYear(NEW_YEARS_EVE_2130_EST, 'UTC')).toBe(2027);
  });
});

describe('getDepartmentTimeZone', () => {
  it('uses the department NERIS config time zone', async () => {
    const send = vi.fn().mockResolvedValue({ Item: { value: { timeZone: 'America/Chicago' } } });
    expect(await getDepartmentTimeZone(fakeClient(send), 'table', DEPT_ID)).toBe('America/Chicago');
    expect((send.mock.calls[0]![0] as { input: { Key: unknown } }).input.Key).toEqual({
      pk: 'DEPT#NICHOLS',
      sk: 'CONFIG#NERIS',
    });
  });

  it('falls back to America/New_York when the config is absent or invalid', async () => {
    const absent = vi.fn().mockResolvedValue({});
    const invalid = vi.fn().mockResolvedValue({ Item: { value: { timeZone: 'Not/AZone' } } });
    expect(await getDepartmentTimeZone(fakeClient(absent), 'table', DEPT_ID)).toBe(
      'America/New_York',
    );
    expect(await getDepartmentTimeZone(fakeClient(invalid), 'table', DEPT_ID)).toBe(
      'America/New_York',
    );
  });

  it('wraps a DynamoDB failure in LosapRepositoryUnavailableError', async () => {
    const send = vi.fn().mockRejectedValue(new Error('down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(getDepartmentTimeZone(fakeClient(send), 'table', DEPT_ID)).rejects.toThrow(
      LosapRepositoryUnavailableError,
    );
    errorSpy.mockRestore();
  });
});

describe('getLosapYear', () => {
  it('derives the year in the department zone', async () => {
    const send = vi.fn().mockResolvedValue({});
    expect(await getLosapYear(fakeClient(send), 'table', DEPT_ID, NEW_YEARS_EVE_2130_EST)).toBe(
      2026,
    );
  });
});
