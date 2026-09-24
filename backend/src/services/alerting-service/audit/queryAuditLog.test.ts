import { describe, expect, it, vi } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  InvalidCursorError,
  decodeCursor,
  encodeCursor,
  queryDepartmentAuditLog,
  queryMemberDeliveryHistory,
  queryMemberDispatchTimeline,
} from './queryAuditLog.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

function mockClient(sendImpl: (command: unknown) => Promise<unknown>) {
  return { send: vi.fn(sendImpl) } as unknown as Parameters<typeof queryMemberDeliveryHistory>[0];
}

describe('queryMemberDeliveryHistory (AC2)', () => {
  it('queries only the given memberId GSI1 partition, scoped to the caller department', async () => {
    const client = mockClient(() =>
      Promise.resolve({ Items: [{ entityType: 'DELIVERY_RECEIPT' }] }),
    );

    const page = await queryMemberDeliveryHistory(client, 'alerting-table', DEPT_ID, 'mbr-102');

    expect(page.entries).toHaveLength(1);
    const call = (client.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      input: {
        IndexName: string;
        FilterExpression: string;
        ExpressionAttributeValues: Record<string, string>;
      };
    };
    expect(call.input.IndexName).toBe('GSI1');
    expect(call.input.ExpressionAttributeValues[':gsi1pk']).toBe('MEMBER#mbr-102');
    expect(call.input.FilterExpression).toBe('deptId = :deptId');
    expect(call.input.ExpressionAttributeValues[':deptId']).toBe('NICHOLS');
  });

  it('returns an empty entries array when the member has no receipts', async () => {
    const client = mockClient(() => Promise.resolve({ Items: [] }));

    const page = await queryMemberDeliveryHistory(client, 'alerting-table', DEPT_ID, 'mbr-nobody');

    expect(page.entries).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('never issues a Put/Update/Delete command (AC3, no write path)', async () => {
    const client = mockClient((command) => {
      expect((command as { constructor: { name: string } }).constructor.name).toBe('QueryCommand');
      return Promise.resolve({ Items: [] });
    });

    await queryMemberDeliveryHistory(client, 'alerting-table', DEPT_ID, 'mbr-102');
  });
});

describe('queryDepartmentAuditLog (AC1/AC4)', () => {
  it('queries GSI2 with a dept-scoped pk and DISPATCH# date range', async () => {
    const client = mockClient(() => Promise.resolve({ Items: [] }));

    await queryDepartmentAuditLog(client, 'alerting-table', DEPT_ID, 100, 200);

    const call = (client.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      input: { IndexName: string; ExpressionAttributeValues: Record<string, string> };
    };
    expect(call.input.IndexName).toBe('GSI2');
    expect(call.input.ExpressionAttributeValues[':gsi2pk']).toBe('DEPT#NICHOLS');
    expect(call.input.ExpressionAttributeValues[':from']).toBe('DISPATCH#100');
    expect(call.input.ExpressionAttributeValues[':to']).toBe('DISPATCH#200');
  });

  it('returns an empty entries array when no dispatches fall in range', async () => {
    const client = mockClient(() => Promise.resolve({ Items: [] }));

    const page = await queryDepartmentAuditLog(client, 'alerting-table', DEPT_ID, 100, 200);

    expect(page.entries).toEqual([]);
  });

  it('assembles a full timeline via a pk fan-out Query per dispatch, filtered server-side', async () => {
    const client = mockClient((command) => {
      const input = (command as { input: Record<string, unknown> }).input;
      if (input.IndexName === 'GSI2') {
        return Promise.resolve({ Items: [{ dispatchId: 'D-1', entityType: 'DISPATCH_ALERT' }] });
      }
      expect(input.KeyConditionExpression).toBe('pk = :pk');
      expect(input.FilterExpression).toBe('entityType IN (:t0, :t1, :t2)');
      expect((input.ExpressionAttributeValues as Record<string, string>)[':pk']).toBe(
        'DEPT#NICHOLS#DISPATCH#D-1',
      );
      return Promise.resolve({
        Items: [
          { entityType: 'DELIVERY_RECEIPT', sk: 'RECEIPT#mbr-1#push#1' },
          { entityType: 'ESCALATION_EVENT', sk: 'ESCALATION#mbr-1#1#500' },
        ],
      });
    });

    const page = await queryDepartmentAuditLog(client, 'alerting-table', DEPT_ID, 100, 200);

    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.dispatchId).toBe('D-1');
    expect(page.entries[0]?.timeline).toHaveLength(2);
    expect(page.entries[0]?.timeline.map((item) => item.entityType)).toEqual([
      'DELIVERY_RECEIPT',
      'ESCALATION_EVENT',
    ]);
  });

  it('paginates the per-dispatch timeline fan-out until LastEvaluatedKey is exhausted', async () => {
    let timelineCalls = 0;
    const client = mockClient((command) => {
      const input = (command as { input: Record<string, unknown> }).input;
      if (input.IndexName === 'GSI2') {
        return Promise.resolve({ Items: [{ dispatchId: 'D-1', entityType: 'DISPATCH_ALERT' }] });
      }
      timelineCalls += 1;
      if (timelineCalls === 1) {
        expect(input.ExclusiveStartKey).toBeUndefined();
        return Promise.resolve({
          Items: [{ entityType: 'DELIVERY_RECEIPT', sk: 'RECEIPT#mbr-1#push#1' }],
          LastEvaluatedKey: { pk: 'DEPT#NICHOLS#DISPATCH#D-1', sk: 'RECEIPT#mbr-1#push#1' },
        });
      }
      expect(input.ExclusiveStartKey).toEqual({
        pk: 'DEPT#NICHOLS#DISPATCH#D-1',
        sk: 'RECEIPT#mbr-1#push#1',
      });
      return Promise.resolve({
        Items: [{ entityType: 'DELIVERY_RECEIPT', sk: 'RECEIPT#mbr-2#sms#1' }],
      });
    });

    const page = await queryDepartmentAuditLog(client, 'alerting-table', DEPT_ID, 100, 200);

    expect(timelineCalls).toBe(2);
    expect(page.entries[0]?.timeline).toHaveLength(2);
  });

  it('returns nextCursor when DynamoDB reports LastEvaluatedKey', async () => {
    const client = mockClient((command) => {
      const input = (command as { input: Record<string, unknown> }).input;
      if (input.IndexName === 'GSI2') {
        return Promise.resolve({ Items: [], LastEvaluatedKey: { pk: 'x', sk: 'y' } });
      }
      return Promise.resolve({ Items: [] });
    });

    const page = await queryDepartmentAuditLog(client, 'alerting-table', DEPT_ID, 100, 200);

    expect(page.nextCursor).toBe(encodeCursor({ pk: 'x', sk: 'y' }));
  });
});

describe('queryMemberDispatchTimeline (MINOR #8: server-side memberId filter)', () => {
  it('pushes the memberId filter into the DynamoDB FilterExpression instead of filtering in application code', async () => {
    const client = mockClient(() =>
      Promise.resolve({
        Items: [{ entityType: 'DELIVERY_RECEIPT', memberId: 'mbr-1', sk: 'RECEIPT#mbr-1#push#1' }],
      }),
    );

    const timeline = await queryMemberDispatchTimeline(
      client,
      'alerting-table',
      DEPT_ID,
      'D-1',
      'mbr-1',
    );

    expect(timeline).toHaveLength(1);
    const call = (client.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      input: {
        FilterExpression: string;
        ExpressionAttributeValues: Record<string, unknown>;
      };
    };
    expect(call.input.FilterExpression).toBe(
      'entityType IN (:t0, :t1, :t2) AND memberId = :memberId',
    );
    expect(call.input.ExpressionAttributeValues[':memberId']).toBe('mbr-1');
  });
});

describe('cursor encode/decode (InvalidCursorError)', () => {
  it('round-trips a key through encodeCursor/decodeCursor', () => {
    const key = { pk: 'DEPT#NICHOLS#DISPATCH#D-1', sk: 'RECEIPT#mbr-1#push#1' };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });

  it('throws InvalidCursorError on a malformed cursor', () => {
    expect(() => decodeCursor('not-base64url-json')).toThrow(InvalidCursorError);
  });
});
