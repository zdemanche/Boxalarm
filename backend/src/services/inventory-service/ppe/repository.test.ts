import { describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  PpeAssignmentConflictError,
  computeNfpaExpiryDate,
  derivePpeStatus,
  issuePpeAssignment,
  listPpeAssignmentsForMember,
  ppeItemIdForType,
  queryPpeAssignmentsDueInMonth,
} from './repository.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const config = { tableName: 'platform-service' };

function fakeClient(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('computeNfpaExpiryDate (AC1 — 10-year NFPA service life)', () => {
  it('adds exactly 10 years to a plain issue date', () => {
    expect(computeNfpaExpiryDate('2026-01-10')).toBe('2036-01-10');
  });

  it('handles a leap-year issueDate (Feb 29) by rolling to the correct non-leap date', () => {
    expect(computeNfpaExpiryDate('2024-02-29')).toBe('2034-03-01');
  });

  it('throws on a non-ISO issueDate rather than silently computing a wrong date', () => {
    expect(() => computeNfpaExpiryDate('01/10/2026')).toThrow(/ISO date/);
  });
});

describe('ppeItemIdForType', () => {
  it('replaces underscores with hyphens', () => {
    expect(ppeItemIdForType('TURNOUT_COAT')).toBe('TURNOUT-COAT');
  });
});

describe('derivePpeStatus (AC3 — computed at read time, core-harm)', () => {
  const now = new Date('2026-09-15T00:00:00Z');

  it('reports EXPIRED, not ISSUED, once nfpaExpiryDate has passed (core-harm)', () => {
    expect(derivePpeStatus('ISSUED', '2026-09-01', now)).toBe('EXPIRED');
  });

  it('reports ISSUED while nfpaExpiryDate is still in the future', () => {
    expect(derivePpeStatus('ISSUED', '2036-01-10', now)).toBe('ISSUED');
  });

  it('reports ISSUED on the expiry date itself (not yet expired)', () => {
    expect(derivePpeStatus('ISSUED', '2026-09-15', now)).toBe('ISSUED');
  });

  it('never overrides a stored RETIRED status even if past expiry', () => {
    expect(derivePpeStatus('RETIRED', '2020-01-01', now)).toBe('RETIRED');
  });
});

describe('issuePpeAssignment (AC1)', () => {
  const params = {
    deptId,
    memberId: 'MBR-1',
    actorId: 'admin-1',
    correlationId: 'trace-1',
    itemType: 'TURNOUT_COAT',
    size: '44R',
    issueDate: '2026-01-10',
    now: new Date('2026-01-10T00:00:00Z'),
  };

  it('writes the PPE_ASSIGNMENT item and an audit entry in one transaction, with GSI1/GSI2 keys', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = fakeClient(send);

    const record = await issuePpeAssignment(client, config, params);

    expect(record).toEqual({
      ppeItemId: 'TURNOUT-COAT',
      memberId: 'MBR-1',
      itemType: 'TURNOUT_COAT',
      size: '44R',
      issueDate: '2026-01-10',
      nfpaExpiryDate: '2036-01-10',
      status: 'ISSUED',
    });
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as TransactWriteCommand;
    expect(command).toBeInstanceOf(TransactWriteCommand);
    const items = command.input.TransactItems ?? [];
    expect(items).toHaveLength(2);
    const assignmentPut = items[0]?.Put;
    expect(assignmentPut?.Item).toMatchObject({
      pk: 'DEPT#NICHOLS#MEMBER#MBR-1',
      sk: 'PPE#TURNOUT-COAT',
      gsi1pk: 'MEMBER#MBR-1',
      gsi1sk: 'PPE_ASSIGNMENT#2036-01-10',
      gsi2pk: 'DEPT#NICHOLS#DUE#PPE_ASSIGNMENT#2036-01',
      gsi2sk: '2036-01-10#TURNOUT-COAT',
      status: 'ISSUED',
    });
    expect(assignmentPut?.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(items[1]?.Put?.Item).toMatchObject({
      mutatedEntityType: 'PPE_ASSIGNMENT',
      action: 'CREATE',
      gsi3pk: 'DEPT#NICHOLS#AUDIT#ENTITY#PPE_ASSIGNMENT#TURNOUT-COAT',
      gsi3sk: '1768003200',
    });
  });

  it('throws PpeAssignmentConflictError, not a raw exception, on a re-issue conflict (409 path)', async () => {
    const send = vi.fn().mockRejectedValue(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      }),
    );
    const client = fakeClient(send);

    await expect(issuePpeAssignment(client, config, params)).rejects.toBeInstanceOf(
      PpeAssignmentConflictError,
    );
  });

  it('logs the original error and rethrows on an unrelated write failure', async () => {
    const failure = new Error('DynamoDB unavailable');
    const send = vi.fn().mockRejectedValue(failure);
    const client = fakeClient(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(issuePpeAssignment(client, config, params)).rejects.toBe(failure);

    const logged = errorSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === 'ppe.issue.failed');
    expect(logged?.reason).toBe('DynamoDB unavailable');
    expect(logged?.errorType).toBe('Error');
    expect(logged?.correlationId).toBe('trace-1');
    errorSpy.mockRestore();
  });
});

describe('listPpeAssignmentsForMember (AC1, AC3, AC4)', () => {
  const now = new Date('2026-09-15T00:00:00Z');

  it('queries by pk + begins_with(sk, "PPE#") and overlays computed status', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          ppeItemId: 'TURNOUT-COAT',
          memberId: 'MBR-1',
          itemType: 'TURNOUT_COAT',
          size: '44R',
          issueDate: '2016-01-10',
          nfpaExpiryDate: '2026-01-10',
          status: 'ISSUED',
        },
      ],
    });
    const client = fakeClient(send);

    const result = await listPpeAssignmentsForMember(client, config, {
      deptId,
      memberId: 'MBR-1',
      correlationId: 'trace-2',
      now,
    });

    expect(result).toEqual([
      {
        ppeItemId: 'TURNOUT-COAT',
        memberId: 'MBR-1',
        itemType: 'TURNOUT_COAT',
        size: '44R',
        issueDate: '2016-01-10',
        nfpaExpiryDate: '2026-01-10',
        status: 'EXPIRED',
      },
    ]);
    const command = send.mock.calls[0]?.[0] as QueryCommand;
    expect(command.input.ExpressionAttributeValues?.[':pk']).toBe('DEPT#NICHOLS#MEMBER#MBR-1');
    expect(command.input.ExpressionAttributeValues?.[':skPrefix']).toBe('PPE#');
  });

  it('returns an empty array, not an error, for a member with zero PPE items', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = fakeClient(send);

    const result = await listPpeAssignmentsForMember(client, config, {
      deptId,
      memberId: 'MBR-none',
      correlationId: 'trace-3',
      now,
    });

    expect(result).toEqual([]);
  });

  it('logs the original error and rethrows on a query failure', async () => {
    const failure = new Error('DynamoDB unavailable');
    const send = vi.fn().mockRejectedValue(failure);
    const client = fakeClient(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      listPpeAssignmentsForMember(client, config, {
        deptId,
        memberId: 'MBR-1',
        correlationId: 'trace-4',
        now,
      }),
    ).rejects.toBe(failure);

    const logged = errorSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === 'ppe.list.failed');
    expect(logged?.correlationId).toBe('trace-4');
    errorSpy.mockRestore();
  });
});

describe('queryPpeAssignmentsDueInMonth (AC2 — GSI2 due-date scan)', () => {
  it('queries GSI2 by gsi2pk and pages through LastEvaluatedKey', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [{ memberId: 'MBR-1', ppeItemId: 'TURNOUT-COAT', nfpaExpiryDate: '2026-10-01' }],
        LastEvaluatedKey: { pk: 'x' },
      })
      .mockResolvedValueOnce({
        Items: [{ memberId: 'MBR-2', ppeItemId: 'HELMET', nfpaExpiryDate: '2026-10-15' }],
      });
    const client = fakeClient(send);

    const result = await queryPpeAssignmentsDueInMonth(client, config, {
      deptId,
      yearMonth: '2026-10',
      correlationId: 'trace-5',
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      { memberId: 'MBR-1', ppeItemId: 'TURNOUT-COAT', expiryDate: '2026-10-01' },
      { memberId: 'MBR-2', ppeItemId: 'HELMET', expiryDate: '2026-10-15' },
    ]);
    const firstCommand = send.mock.calls[0]?.[0] as QueryCommand;
    expect(firstCommand.input.IndexName).toBe('GSI2');
    expect(firstCommand.input.ExpressionAttributeValues?.[':gsi2pk']).toBe(
      'DEPT#NICHOLS#DUE#PPE_ASSIGNMENT#2026-10',
    );
  });

  it('logs the original error and rethrows on a GSI2 query failure', async () => {
    const failure = new Error('DynamoDB unavailable');
    const send = vi.fn().mockRejectedValue(failure);
    const client = fakeClient(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      queryPpeAssignmentsDueInMonth(client, config, {
        deptId,
        yearMonth: '2026-10',
        correlationId: 'trace-6',
      }),
    ).rejects.toBe(failure);

    const logged = errorSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === 'ppe.queryDueInMonth.failed');
    expect(logged?.correlationId).toBe('trace-6');
    errorSpy.mockRestore();
  });
});
