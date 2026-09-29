import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent } from 'aws-lambda';

/**
 * The digest-bound reminder consumers: each unwraps the EventBridge envelope under
 * `detail`, records one DIGEST_PENDING row per recipient its category routes to plus the
 * eventId marker in a single conditional transaction, and fails closed on a bad message.
 */

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ now: new Date('2026-09-29T08:00:00Z'), toFake: ['Date'] });
  process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-service';
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock('../dynamoClient.js');
});

function sqsEvent(eventType: string, source: string, payload: Record<string, unknown>): SQSEvent {
  return {
    Records: [
      {
        messageId: 'msg-1',
        body: JSON.stringify({
          version: '0',
          id: 'eb-1',
          'detail-type': eventType,
          source,
          detail: {
            eventId: 'evt-1',
            eventTime: '2026-09-29T08:00:00Z',
            eventType,
            source,
            correlationId: 'trace-1',
            schemaVersion: '1.0',
            payload,
          },
        }),
      },
    ],
  } as unknown as SQSEvent;
}

function mockDdb(send: ReturnType<typeof vi.fn>): void {
  vi.doMock('../dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../dynamoClient.js')>();
    return { ...actual, createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
  });
}

type Put = { Item: Record<string, unknown>; ConditionExpression: string };

function putsOf(send: ReturnType<typeof vi.fn>): Put[] {
  const command = send.mock.calls[0]?.[0] as {
    constructor: { name: string };
    input: { TransactItems: { Put: Put }[] };
  };
  expect(command.constructor.name).toBe('TransactWriteCommand');
  return command.input.TransactItems.map((t) => t.Put);
}

const TEST_DUE = {
  apparatusId: 'APP-E1',
  testType: 'HOSE',
  dueDate: '2026-10-20',
  deptId: 'NICHOLS',
};
const SCBA_DUE = {
  apparatusId: 'ENGINE-2',
  testType: 'SCBA_FLOW',
  dueDate: '2026-10-02',
  scbaUnitId: 'SCBA-001',
  cylinderId: 'CYL-0891',
  deptId: 'NICHOLS',
};
const REORDER = {
  itemId: 'GLOVES-L',
  itemName: 'Gloves (Large)',
  currentQty: 3,
  reorderThreshold: 5,
  deptId: 'NICHOLS',
};
const PPE = {
  memberId: 'MBR-0034',
  ppeItemId: 'TURNOUT-COAT',
  expiryDate: '2026-10-14',
  deptId: 'NICHOLS',
};

describe('apparatusTestDueConsumer', () => {
  it('records the test for APPARATUS and CHIEF, with the eventId marker, all conditional', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./apparatusTestDueConsumer.js');

    await handler(sqsEvent('apparatus.test.due', 'apparatus-service', TEST_DUE));

    const puts = putsOf(send);
    expect(puts.map((p) => p.Item.pk)).toEqual([
      'DEPT#NICHOLS#ROLE#APPARATUS',
      'DEPT#NICHOLS#ROLE#CHIEF',
      'DEPT#NICHOLS#NOTIF_EVENT#evt-1',
    ]);
    expect(puts.every((p) => p.ConditionExpression === 'attribute_not_exists(sk)')).toBe(true);
    expect(puts[0]?.Item).toMatchObject({
      sk: 'DIGEST_PENDING#apparatus-test-due#2026-09-29#APP-E1:HOSE',
      gsi3pk: 'DEPT#NICHOLS#DIGEST_PENDING#2026-09-29',
      category: 'apparatus-test-due',
      dueDate: '2026-10-20',
      item: {
        subjectId: 'APP-E1:HOSE',
        title: 'APP-E1',
        detail: 'hose test due 2026-10-20',
        link: { kind: 'apparatus' },
      },
    });
  });

  it('accepts the SCBA scanner’s shape and keys the reminder by SCBA unit', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./apparatusTestDueConsumer.js');

    await handler(sqsEvent('apparatus.test.due', 'apparatus-service', SCBA_DUE));

    expect(putsOf(send)[0]?.Item.item).toMatchObject({
      subjectId: 'SCBA-001:SCBA_FLOW',
      title: 'ENGINE-2',
      detail: 'SCBA SCBA-001 flow test due 2026-10-02',
    });
  });

  it('buckets a reminder recorded after the 12:00 UTC digest under the next day', async () => {
    vi.setSystemTime(new Date('2026-09-29T15:00:00Z'));
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./apparatusTestDueConsumer.js');

    await handler(sqsEvent('apparatus.test.due', 'apparatus-service', TEST_DUE));

    expect(putsOf(send)[0]?.Item.gsi3pk).toBe('DEPT#NICHOLS#DIGEST_PENDING#2026-09-30');
  });

  it('is a no-op on a redelivered event', async () => {
    const duplicate = Object.assign(new Error('dup'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    });
    const send = vi.fn().mockRejectedValueOnce(duplicate);
    mockDdb(send);
    const { handler } = await import('./apparatusTestDueConsumer.js');

    await expect(
      handler(sqsEvent('apparatus.test.due', 'apparatus-service', TEST_DUE)),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects (for redelivery / DLQ) an event without deptId, writing nothing', async () => {
    const send = vi.fn();
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./apparatusTestDueConsumer.js');

    const withoutDept: Record<string, unknown> = { ...TEST_DUE };
    delete withoutDept.deptId;
    await expect(
      handler(sqsEvent('apparatus.test.due', 'apparatus-service', withoutDept)),
    ).rejects.toThrow('apparatus.test.due event failed shape validation');
    expect(send).not.toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(
      'notification.apparatusTestDue.malformed_event',
    );
  });

  it('rejects a bare envelope that was not wrapped by EventBridge', async () => {
    const send = vi.fn();
    mockDdb(send);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./apparatusTestDueConsumer.js');

    const bare = {
      Records: [
        {
          messageId: 'm',
          body: JSON.stringify({
            eventId: 'e',
            eventType: 'apparatus.test.due',
            payload: TEST_DUE,
          }),
        },
      ],
    } as unknown as SQSEvent;
    await expect(handler(bare)).rejects.toThrow('failed shape validation');
    expect(send).not.toHaveBeenCalled();
  });

  it('rethrows a genuine write failure so SQS redelivers', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('throttled'));
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./apparatusTestDueConsumer.js');

    await expect(
      handler(sqsEvent('apparatus.test.due', 'apparatus-service', TEST_DUE)),
    ).rejects.toThrow('throttled');
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(
      'notification.apparatusTestDue.write_failed',
    );
  });
});

describe('inventoryReorderDueConsumer', () => {
  it('records the item for APPARATUS and ADMIN, linking to consumables', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./inventoryReorderDueConsumer.js');

    await handler(sqsEvent('inventory.reorder.due', 'inventory-service', REORDER));

    const puts = putsOf(send);
    expect(puts.map((p) => p.Item.pk)).toEqual([
      'DEPT#NICHOLS#ROLE#APPARATUS',
      'DEPT#NICHOLS#ROLE#ADMIN',
      'DEPT#NICHOLS#NOTIF_EVENT#evt-1',
    ]);
    expect(puts[0]?.Item.item).toEqual({
      subjectId: 'GLOVES-L',
      title: 'Gloves (Large)',
      detail: '3 on hand, reorder at 5',
      link: { kind: 'consumables' },
    });
  });

  it('rejects a non-numeric quantity', async () => {
    const send = vi.fn();
    mockDdb(send);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./inventoryReorderDueConsumer.js');

    await expect(
      handler(
        sqsEvent('inventory.reorder.due', 'inventory-service', { ...REORDER, currentQty: '3' }),
      ),
    ).rejects.toThrow('inventory.reorder.due event failed shape validation');
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an event of another type delivered to its queue', async () => {
    const send = vi.fn();
    mockDdb(send);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./inventoryReorderDueConsumer.js');

    await expect(handler(sqsEvent('ppe.expiry.due', 'inventory-service', REORDER))).rejects.toThrow(
      'failed shape validation',
    );
  });
});

describe('ppeExpiryConsumer', () => {
  it('records the holder’s own copy and the APPARATUS role’s copy naming the holder', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./ppeExpiryConsumer.js');

    await handler(sqsEvent('ppe.expiry.due', 'inventory-service', PPE));

    const puts = putsOf(send);
    expect(puts.map((p) => p.Item.pk)).toEqual([
      'DEPT#NICHOLS#MEMBER#MBR-0034',
      'DEPT#NICHOLS#ROLE#APPARATUS',
      'DEPT#NICHOLS#NOTIF_EVENT#evt-1',
    ]);
    expect(puts[0]?.Item.item).toMatchObject({
      subjectId: 'MBR-0034:TURNOUT-COAT',
      title: 'TURNOUT-COAT',
      detail: 'expires 2026-10-14',
      link: { kind: 'member', id: 'MBR-0034' },
    });
    expect(puts[1]?.Item.item).toMatchObject({ detail: 'held by MBR-0034, expires 2026-10-14' });
  });

  it('accepts the N-5 rename inventory.expiry.due', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./ppeExpiryConsumer.js');

    await handler(sqsEvent('inventory.expiry.due', 'inventory-service', PPE));

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('NERIS report consumers', () => {
  it('neris.submission.failed -> an immediate inbox item for the owner, the locking officer and every officer', async () => {
    const send = vi.fn(
      (command: { constructor: { name: string }; input: Record<string, unknown> }) =>
        Promise.resolve(
          command.constructor.name === 'QueryCommand'
            ? {
                Items: [
                  { memberId: 'MBR-0100', roles: ['OFFICER'], status: 'ACTIVE' },
                  { memberId: 'MBR-0200', roles: ['MEMBER'], status: 'ACTIVE' },
                ],
              }
            : {},
        ),
    );
    mockDdb(send);
    const { handler } = await import('./nerisReportConsumer.js');

    await handler(
      sqsEvent('neris.submission.failed', 'incident-service', {
        incidentId: 'NICHOLS-4471-1798000000',
        deptId: 'NICHOLS',
        ownerId: 'MBR-0034',
        lockedBy: 'MBR-0012',
        incidentNumber: '4471',
        outcome: 'CLIENT_ERROR',
        failureReason: 'NERIS refused the request with HTTP 401',
      }),
    );

    const inbox = send.mock.calls
      .map(([command]) => command)
      .filter((command) => command.constructor.name === 'PutCommand')
      .map((command) => command.input.Item as Record<string, unknown>);
    expect(inbox.map((item) => item.memberId).sort()).toEqual(['MBR-0012', 'MBR-0034', 'MBR-0100']);
    expect(inbox[0]).toMatchObject({
      entityType: 'NOTIFICATION',
      category: 'neris-rejected',
      items: [
        {
          title: 'Report 4471',
          detail: expect.stringContaining('HTTP 401') as unknown,
          link: { kind: 'incident', id: 'NICHOLS-4471-1798000000' },
        },
      ],
    });
  });

  it('neris.incident.rejected -> a neris-rejected reminder for the report owner, linking to the report', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./nerisReportConsumer.js');

    await handler(
      sqsEvent('neris.incident.rejected', 'incident-service', {
        incidentId: 'NICHOLS-4471-1798000000',
        deptId: 'NICHOLS',
        ownerId: 'MBR-0034',
        incidentNumber: '4471',
        nerisStatus: 'REJECTED',
        statusAt: '2026-09-30T09:00:00Z',
      }),
    );

    const puts = putsOf(send);
    // Owner's digest row, the OFFICER role's digest row, the event marker.
    expect(puts).toHaveLength(3);
    expect(puts[0]!.Item).toMatchObject({
      pk: 'DEPT#NICHOLS#MEMBER#MBR-0034',
      category: 'neris-rejected',
      item: {
        subjectId: 'NICHOLS-4471-1798000000:neris.incident.rejected:2026-09-30T09:00:00Z',
        title: 'Report 4471',
        link: { kind: 'incident', id: 'NICHOLS-4471-1798000000' },
      },
    });
  });

  it('neris.incident.failed says NERIS could not process it', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./nerisReportConsumer.js');
    await handler(
      sqsEvent('neris.incident.failed', 'incident-service', {
        incidentId: 'I-1',
        deptId: 'NICHOLS',
        ownerId: 'MBR-0034',
      }),
    );
    expect(putsOf(send)[0]!.Item).toMatchObject({
      item: { detail: expect.stringContaining("couldn't be processed") as unknown },
    });
  });

  it('neris.no_activity.due -> one reminder each for the CHIEF and ADMIN roles', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./nerisNoActivityConsumer.js');
    await handler(
      sqsEvent('neris.no_activity.due', 'incident-service', {
        deptId: 'NICHOLS',
        month: '2026-09',
      }),
    );
    const puts = putsOf(send);
    expect(puts.map((p) => p.Item.pk)).toEqual([
      'DEPT#NICHOLS#ROLE#CHIEF',
      'DEPT#NICHOLS#ROLE#ADMIN',
      expect.stringContaining('DEPT#NICHOLS') as unknown,
    ]);
    expect(puts[0]!.Item).toMatchObject({
      category: 'neris-no-activity',
      item: { subjectId: 'no-activity:2026-09', link: { kind: 'incident' } },
    });
  });

  it('fails closed on a rejection with no owner', async () => {
    mockDdb(vi.fn());
    const { handler } = await import('./nerisReportConsumer.js');
    await expect(
      handler(
        sqsEvent('neris.incident.rejected', 'incident-service', {
          incidentId: 'I',
          deptId: 'NICHOLS',
        }),
      ),
    ).rejects.toThrow();
  });
});
