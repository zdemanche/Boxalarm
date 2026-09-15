import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  buildYearEndReport,
  listLosapEligibleMembers,
  sumLosapPointsForMemberYear,
} from './repository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'platform-table';

function fakeClient(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('listLosapEligibleMembers', () => {
  it('queries GSI3 for the department member list and keeps only ACTIVE/RETIRED members', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        { memberId: 'MBR-0001', status: 'ACTIVE' },
        { memberId: 'MBR-0002', status: 'RETIRED' },
        { memberId: 'MBR-0003', status: 'PROBATIONARY' },
        { memberId: 'MBR-0004', status: 'LOA' },
      ],
    });
    const client = fakeClient(send);
    const roster = await listLosapEligibleMembers(client, TABLE, DEPT_ID);
    expect(roster).toEqual([
      { memberId: 'MBR-0001', status: 'ACTIVE' },
      { memberId: 'MBR-0002', status: 'RETIRED' },
    ]);
    const command = send.mock.calls[0]?.[0] as {
      input: { IndexName: string; ExpressionAttributeValues: Record<string, unknown> };
    };
    expect(command.input.IndexName).toBe('GSI3');
    expect(command.input.ExpressionAttributeValues[':gsi3pk']).toBe(`DEPT#${DEPT_ID}#MEMBER`);
  });

  it('follows LastEvaluatedKey across pages so the roster is never under-reported (P8)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [{ memberId: 'MBR-0001', status: 'ACTIVE' }],
        LastEvaluatedKey: { pk: 'p', sk: 's' },
      })
      .mockResolvedValueOnce({ Items: [{ memberId: 'MBR-0002', status: 'ACTIVE' }] });
    const client = fakeClient(send);
    const roster = await listLosapEligibleMembers(client, TABLE, DEPT_ID);
    expect(roster).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('logs the original error and rethrows without swallowing on a Query failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('table unavailable');
    const send = vi.fn().mockRejectedValue(failure);
    const client = fakeClient(send);
    await expect(listLosapEligibleMembers(client, TABLE, DEPT_ID)).rejects.toBe(failure);
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as { message: string };
    expect(logged.message).toBe('table unavailable');
  });
});

describe('sumLosapPointsForMemberYear', () => {
  it('sums points as-recorded across entries with different ruleVersionIds (AC3)', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        { points: 1, ruleVersionId: 'RULE-2026' },
        { points: 2, ruleVersionId: 'RULE-2026-REVISED' },
      ],
    });
    const client = fakeClient(send);
    const result = await sumLosapPointsForMemberYear(client, TABLE, 'MBR-0012', 2026);
    expect(result).toEqual({ totalPoints: 3, entryCount: 2 });
  });

  it('queries GSI1 scoped to the member and year prefix', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const client = fakeClient(send);
    await sumLosapPointsForMemberYear(client, TABLE, 'MBR-0012', 2026);
    const command = send.mock.calls[0]?.[0] as {
      input: {
        IndexName: string;
        KeyConditionExpression: string;
        ExpressionAttributeValues: Record<string, unknown>;
      };
    };
    expect(command.input.IndexName).toBe('GSI1');
    expect(command.input.ExpressionAttributeValues).toEqual({
      ':gsi1pk': 'MEMBER#MBR-0012',
      ':prefix': 'LOSAP_POINT_ENTRY#2026',
    });
  });

  it('returns zero total and zero entryCount when the member has no entries for the year (AC2)', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const client = fakeClient(send);
    const result = await sumLosapPointsForMemberYear(client, TABLE, 'MBR-0099', 2026);
    expect(result).toEqual({ totalPoints: 0, entryCount: 0 });
  });

  it('treats a missing/non-numeric points field as 0 without throwing', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [{ ruleVersionId: 'RULE-2026' }, { points: 'not-a-number' }],
    });
    const client = fakeClient(send);
    const result = await sumLosapPointsForMemberYear(client, TABLE, 'MBR-0012', 2026);
    expect(result).toEqual({ totalPoints: 0, entryCount: 2 });
  });

  it('follows LastEvaluatedKey across pages (P8)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [{ points: 1 }], LastEvaluatedKey: { pk: 'p', sk: 's' } })
      .mockResolvedValueOnce({ Items: [{ points: 1 }] });
    const client = fakeClient(send);
    const result = await sumLosapPointsForMemberYear(client, TABLE, 'MBR-0012', 2026);
    expect(result).toEqual({ totalPoints: 2, entryCount: 2 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('logs the original error and rethrows without swallowing on a Query failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('query throttled');
    const send = vi.fn().mockRejectedValue(failure);
    const client = fakeClient(send);
    await expect(sumLosapPointsForMemberYear(client, TABLE, 'MBR-0012', 2026)).rejects.toBe(
      failure,
    );
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as { message: string };
    expect(logged.message).toBe('query throttled');
  });
});

describe('buildYearEndReport', () => {
  it('includes a zero-entry member at totalPoints 0 rather than omitting them (AC2)', async () => {
    const send = vi.fn().mockImplementation((command: unknown) => {
      const input = (
        command as {
          input: { IndexName: string; ExpressionAttributeValues: Record<string, unknown> };
        }
      ).input;
      if (input.IndexName === 'GSI3') {
        return Promise.resolve({
          Items: [
            { memberId: 'MBR-0001', status: 'ACTIVE' },
            { memberId: 'MBR-0002', status: 'ACTIVE' },
          ],
        });
      }
      const gsi1pk = input.ExpressionAttributeValues[':gsi1pk'];
      if (gsi1pk === 'MEMBER#MBR-0001') {
        return Promise.resolve({ Items: [{ points: 5 }] });
      }
      return Promise.resolve({ Items: [] });
    });
    const client = fakeClient(send);
    const report = await buildYearEndReport(client, TABLE, DEPT_ID, 2026);
    expect(report.members).toEqual(
      expect.arrayContaining([
        { memberId: 'MBR-0001', totalPoints: 5, entryCount: 1 },
        { memberId: 'MBR-0002', totalPoints: 0, entryCount: 0 },
      ]),
    );
    expect(report.members).toHaveLength(2);
  });

  it('sets hasData=false when every eligible member has zero entries for the year (AC4)', async () => {
    const send = vi.fn().mockImplementation((command: unknown) => {
      const input = (command as { input: { IndexName: string } }).input;
      if (input.IndexName === 'GSI3') {
        return Promise.resolve({ Items: [{ memberId: 'MBR-0001', status: 'ACTIVE' }] });
      }
      return Promise.resolve({ Items: [] });
    });
    const client = fakeClient(send);
    const report = await buildYearEndReport(client, TABLE, DEPT_ID, 2026);
    expect(report.hasData).toBe(false);
    expect(report.members).toEqual([{ memberId: 'MBR-0001', totalPoints: 0, entryCount: 0 }]);
  });

  it('sets hasData=true when at least one member has an entry', async () => {
    const send = vi.fn().mockImplementation((command: unknown) => {
      const input = (command as { input: { IndexName: string } }).input;
      if (input.IndexName === 'GSI3') {
        return Promise.resolve({ Items: [{ memberId: 'MBR-0001', status: 'ACTIVE' }] });
      }
      return Promise.resolve({ Items: [{ points: 1 }] });
    });
    const client = fakeClient(send);
    const report = await buildYearEndReport(client, TABLE, DEPT_ID, 2026);
    expect(report.hasData).toBe(true);
  });

  it('returns an empty member list with hasData=false when the department has no eligible roster', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const client = fakeClient(send);
    const report = await buildYearEndReport(client, TABLE, DEPT_ID, 2026);
    expect(report).toEqual({ deptId: DEPT_ID, year: 2026, members: [], hasData: false });
  });

  it('propagates a per-member Query rejection rather than silently dropping that member (fail-closed, core-harm)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('member query throttled');
    const send = vi.fn().mockImplementation((command: unknown) => {
      const input = (command as { input: { IndexName: string } }).input;
      if (input.IndexName === 'GSI3') {
        return Promise.resolve({
          Items: [
            { memberId: 'MBR-0001', status: 'ACTIVE' },
            { memberId: 'MBR-0002', status: 'ACTIVE' },
          ],
        });
      }
      return Promise.reject(failure);
    });
    const client = fakeClient(send);
    await expect(buildYearEndReport(client, TABLE, DEPT_ID, 2026)).rejects.toBe(failure);
    expect(errorSpy).toHaveBeenCalled();
  });
});
