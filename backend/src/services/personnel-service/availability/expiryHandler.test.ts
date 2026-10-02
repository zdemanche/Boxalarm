import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_TABLE_NAME = 'platform-table';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function mockDdb(client: { send: ReturnType<typeof vi.fn> }): void {
  vi.doMock('./dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./dynamoClient.js')>();
    return { ...actual, createDdbClient: () => client as unknown as DynamoDBDocumentClient };
  });
}

describe('expiryHandler (entrypoint-test obligation)', () => {
  it('rethrows on a malformed payload (missing required fields)', async () => {
    const { handler } = await import('./expiryHandler.js');
    await expect(handler({ deptId: 'NICHOLS' })).rejects.toThrow(
      'expiry schedule payload failed shape validation',
    );
  });

  it('no-ops SKIPPED_NOT_FOUND when the markoff item is absent', async () => {
    mockDdb({ send: vi.fn().mockResolvedValue({ Item: undefined }) });
    const { handler } = await import('./expiryHandler.js');
    const result = await handler({ deptId: 'NICHOLS', memberId: 'mbr-1', startAt: 100 });
    expect(result).toEqual({ outcome: 'SKIPPED_NOT_FOUND' });
  });

  it('no-ops SKIPPED_ALREADY_REVERTED on a redelivered fire (revertedAt already set) — never re-emits the event (AC4)', async () => {
    const send = vi.fn().mockResolvedValue({
      Item: {
        pk: 'DEPT#NICHOLS#MEMBER#mbr-1',
        sk: 'MARKOFF#100',
        entityType: 'AVAILABILITY_MARKOFF',
        memberId: 'mbr-1',
        deptId: 'NICHOLS',
        startAt: 100,
        endAt: 200,
        affectsAlerting: true,
        revertedAt: 150,
      },
    });
    mockDdb({ send });
    const { handler } = await import('./expiryHandler.js');
    const result = await handler({ deptId: 'NICHOLS', memberId: 'mbr-1', startAt: 100 });
    expect(result).toEqual({ outcome: 'SKIPPED_ALREADY_REVERTED' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reverts and emits a personnel.availability.changed AVAILABLE outbox entry when the window has ended (AC4)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Item: {
          pk: 'DEPT#NICHOLS#MEMBER#mbr-1',
          sk: 'MARKOFF#100',
          entityType: 'AVAILABILITY_MARKOFF',
          memberId: 'mbr-1',
          deptId: 'NICHOLS',
          startAt: 100,
          endAt: 200,
          affectsAlerting: true,
        },
      })
      .mockResolvedValueOnce({});
    mockDdb({ send });
    const { handler } = await import('./expiryHandler.js');
    const result = await handler({ deptId: 'NICHOLS', memberId: 'mbr-1', startAt: 100 });
    expect(result).toEqual({ outcome: 'REVERTED' });

    const transactCall = send.mock.calls[1]?.[0] as {
      input: { TransactItems: { Put?: { Item: Record<string, unknown> } }[] };
    };
    const outboxItem = transactCall.input.TransactItems.find((t) => t.Put)?.Put?.Item;
    expect(outboxItem).toMatchObject({
      entityType: 'OUTBOX_ENTRY',
      eventType: 'personnel.availability.changed',
    });
    const outboxPayload = outboxItem?.payload as { availabilityState: string } | undefined;
    expect(outboxPayload?.availabilityState).toBe('AVAILABLE');
  });

  // Paging review MAJOR-R2-1: an ACTIVATE landing between the REVERT's read and its write.
  it('a REVERT that loses to an activation re-reads and stamps AVAILABLE after it', async () => {
    const row = {
      pk: 'DEPT#NICHOLS#MEMBER#mbr-1',
      sk: 'MARKOFF#100',
      entityType: 'AVAILABILITY_MARKOFF',
      memberId: 'mbr-1',
      deptId: 'NICHOLS',
      startAt: 100,
      endAt: 200,
      affectsAlerting: true,
    };
    const activatedAt = Math.floor(Date.now() / 1000);
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: row })
      .mockRejectedValueOnce(
        Object.assign(new Error('cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        }),
      )
      .mockResolvedValueOnce({ Item: { ...row, activatedAt } })
      .mockResolvedValueOnce({});
    mockDdb({ send });
    const { handler } = await import('./expiryHandler.js');

    expect(await handler({ deptId: 'NICHOLS', memberId: 'mbr-1', startAt: 100 })).toEqual({
      outcome: 'REVERTED',
    });
    type Transact = {
      input: {
        TransactItems: {
          Update?: { ConditionExpression: string };
          Put?: { Item: Record<string, unknown> };
        }[];
      };
    };
    const first = send.mock.calls[1]![0] as Transact;
    const retry = send.mock.calls[3]![0] as Transact;
    expect(first.input.TransactItems[0]!.Update!.ConditionExpression).toContain(
      'attribute_not_exists(activatedAt)',
    );
    expect(retry.input.TransactItems[0]!.Update!.ConditionExpression).toContain(
      'activatedAt = :readActivatedAt',
    );
    const eventTime = Date.parse(String(retry.input.TransactItems[1]!.Put!.Item.eventTime));
    expect(eventTime).toBeGreaterThanOrEqual((activatedAt + 1) * 1000);
  });

  it('rethrows on a genuine DynamoDB failure so the scheduler invocation retries', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Item: {
          pk: 'DEPT#NICHOLS#MEMBER#mbr-1',
          sk: 'MARKOFF#100',
          entityType: 'AVAILABILITY_MARKOFF',
          memberId: 'mbr-1',
          deptId: 'NICHOLS',
          startAt: 100,
          endAt: 200,
          affectsAlerting: true,
        },
      })
      .mockRejectedValueOnce(new Error('ddb unavailable'));
    mockDdb({ send });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./expiryHandler.js');
    await expect(handler({ deptId: 'NICHOLS', memberId: 'mbr-1', startAt: 100 })).rejects.toThrow(
      'ddb unavailable',
    );
    errorSpy.mockRestore();
  });
});
