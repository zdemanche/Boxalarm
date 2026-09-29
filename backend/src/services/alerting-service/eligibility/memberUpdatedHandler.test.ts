import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

/**
 * A real EventBridge→SQS body: the rule target has no inputPath, so SQS receives the whole
 * EventBridge event and the outbox drainer's envelope (drainHandler.ts `Detail`) is under `detail`.
 */
function buildSqsEvent(envelope: unknown): SQSEvent {
  const eventBridgeEvent = {
    version: '0',
    id: '6a7e8feb-b491-4cf7-a9f1-bf3703467718',
    'detail-type': 'personnel.member.updated',
    source: 'personnel-service',
    account: '123456789012',
    time: '2026-09-14T00:00:00Z',
    region: 'us-east-1',
    resources: [],
    detail: envelope,
  };
  return { Records: [{ body: JSON.stringify(eventBridgeEvent) }] } as unknown as SQSEvent;
}

const VALID_ENVELOPE = {
  eventId: 'evt-1',
  eventTime: '2026-09-14T00:00:00.000Z',
  eventType: 'personnel.member.updated',
  source: 'personnel-service',
  correlationId: 'mbr-102',
  schemaVersion: '1.0',
  payload: {
    deptId: 'NICHOLS',
    memberId: 'mbr-102',
    active: true,
    contactChannels: [{ channel: 'PUSH', platform: 'APNS', token: 'tok-1', valid: true }],
  },
};

interface SentUpdate {
  readonly input: {
    Key: { pk: string; sk: string };
    UpdateExpression: string;
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues: Record<string, unknown>;
  };
}

/** The UpdateCommand that wrote contactChannels (the contact projection's write). */
function contactWrite(send: ReturnType<typeof vi.fn>): SentUpdate['input'] | undefined {
  const commands = send.mock.calls.map((call: unknown[]) => call[0]) as (SentUpdate & {
    constructor: { name: string };
  })[];
  return commands
    .filter((command) => command.constructor.name === 'UpdateCommand')
    .map((command) => command.input)
    .find((input) => input.ExpressionAttributeValues[':contactChannels'] !== undefined);
}

describe('memberUpdatedHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('./dynamoClient.js');
  });

  it('throws (never swallows) when the payload is missing memberId, so SQS retries/DLQs (AC-matrix)', async () => {
    const send = vi.fn();
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    await expect(
      handler(
        buildSqsEvent({
          ...VALID_ENVELOPE,
          payload: { ...VALID_ENVELOPE.payload, memberId: undefined },
        }),
      ),
    ).rejects.toThrow('memberId');
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a bare envelope with no EventBridge `detail` wrapper (never what the rule delivers)', async () => {
    const send = vi.fn();
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    const bare = { Records: [{ body: JSON.stringify(VALID_ENVELOPE) }] } as unknown as SQSEvent;
    await expect(handler(bare)).rejects.toThrow('missing detail');
    expect(send).not.toHaveBeenCalled();
  });

  it('upserts MEMBER_ELIGIBILITY_SNAPSHOT with the PUSH entries denormalized from the event payload (AC1, AC2)', async () => {
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    const result = await handler(buildSqsEvent(VALID_ENVELOPE));

    expect(result).toEqual({ batchItemFailures: [] });
    const write = contactWrite(send);
    expect(write?.Key).toEqual({ pk: 'DEPT#NICHOLS#ELIGIBILITY', sk: 'MEMBER#mbr-102' });
    expect(write?.ExpressionAttributeValues[':contactChannels']).toEqual(
      VALID_ENVELOPE.payload.contactChannels,
    );
  });

  it('propagates an empty contactChannels array (AC5 revoke) into the snapshot', async () => {
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    await handler(
      buildSqsEvent({
        ...VALID_ENVELOPE,
        payload: { deptId: 'NICHOLS', memberId: 'mbr-102', active: false, contactChannels: [] },
      }),
    );

    expect(contactWrite(send)?.ExpressionAttributeValues[':contactChannels']).toEqual([]);
    const eligibility = (send.mock.calls[0]?.[0] as SentUpdate).input;
    expect(eligibility.ExpressionAttributeValues[':value']).toBe(false);
    expect(eligibility.UpdateExpression).toContain('active = :value');
  });

  it('a register-only event (no quals/roles/availabilityState) does not clear those fields (P6 regression)', async () => {
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    await handler(
      buildSqsEvent({
        ...VALID_ENVELOPE,
        payload: {
          deptId: 'NICHOLS',
          memberId: 'mbr-102',
          contactChannels: [{ channel: 'PUSH', platform: 'APNS', token: 'tok-1', valid: true }],
        },
      }),
    );

    const write = contactWrite(send)!;
    // Absent fields are only seeded where the snapshot has none (if_not_exists), never
    // overwritten - so a stored quals/roles/active survives a register-only event.
    for (const field of ['quals', '#roles', 'active', 'availabilityState']) {
      expect(write.UpdateExpression).not.toContain(`${field} = :${field.replace('#', '')},`);
      expect(write.UpdateExpression).toContain(`${field} = if_not_exists(${field},`);
    }
    // `roles` is a DynamoDB reserved word: it must only ever appear through its name alias.
    expect(write.UpdateExpression).not.toMatch(/(^|[^#])roles = /);
    expect(write.ExpressionAttributeNames).toEqual({ '#roles': 'roles' });
    expect(write.ExpressionAttributeValues[':quals']).toBeUndefined();
    expect(write.ExpressionAttributeValues[':active']).toBeUndefined();
    // A contact change never moves snapshotUpdatedAt, which the availability consumer guards
    // on - it only seeds it for a first-ever event.
    expect(write.UpdateExpression).toContain(
      'snapshotUpdatedAt = if_not_exists(snapshotUpdatedAt, :eventTime)',
    );
  });

  // Review MAJOR-2: a role change was guarded on the snapshot-wide snapshotUpdatedAt, so any
  // newer availability/push-token/status event applied first made it "stale" - the promoted
  // officer never reached mutual aid.
  it('guards a role change on rolesUpdatedAt alone, so a newer unrelated event cannot drop it', async () => {
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    await handler(
      buildSqsEvent({
        ...VALID_ENVELOPE,
        payload: { deptId: 'NICHOLS', memberId: 'mbr-102', roles: ['MEMBER', 'OFFICER'] },
      }),
    );

    expect(send).toHaveBeenCalledTimes(1);
    const input = (
      send.mock.calls[0]?.[0] as {
        input: { ConditionExpression: string; UpdateExpression: string };
      }
    ).input;
    expect(input.ConditionExpression).toBe(
      'attribute_not_exists(rolesUpdatedAt) OR rolesUpdatedAt < :rolesUpdatedAt',
    );
    // Only seeds snapshotUpdatedAt; never moves it, so it cannot make other events stale.
    expect(input.UpdateExpression).toContain(
      'snapshotUpdatedAt = if_not_exists(snapshotUpdatedAt, :rolesUpdatedAt)',
    );
    // A first-ever event (a brand-new chief) still yields a snapshot the selector accepts.
    expect(input.UpdateExpression).toContain('active = if_not_exists(active, :defaultActive)');
  });

  // `roles` is a DynamoDB reserved word. Bare in an expression it fails the whole UpdateItem
  // (ValidationException), and every member.updated event seeds or sets roles - so the
  // consumer DLQ'd every push-token, status and role change. Found against LocalStack; the
  // in-memory fakes accepted it.
  it('names roles only through #roles in every expression it sends', async () => {
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    await handler(
      buildSqsEvent({
        ...VALID_ENVELOPE,
        payload: { deptId: 'NICHOLS', memberId: 'mbr-102', active: true, roles: ['OFFICER'] },
      }),
    );

    expect(send).toHaveBeenCalledTimes(2);
    for (const [command] of send.mock.calls) {
      const input = (
        command as {
          input: { UpdateExpression: string; ExpressionAttributeNames?: Record<string, string> };
        }
      ).input;
      expect(input.UpdateExpression).not.toMatch(/(^|[\s,(])roles\b/);
      expect(input.ExpressionAttributeNames).toEqual({ '#roles': 'roles' });
    }
  });

  it('applies roles and other fields as two independently guarded updates', async () => {
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    await handler(
      buildSqsEvent({
        ...VALID_ENVELOPE,
        payload: { deptId: 'NICHOLS', memberId: 'mbr-102', active: false, roles: ['MEMBER'] },
      }),
    );

    const conditions = send.mock.calls.map(
      (call) => (call[0] as { input: { ConditionExpression: string } }).input.ConditionExpression,
    );
    expect(conditions).toEqual([
      'attribute_not_exists(activeUpdatedAt) OR activeUpdatedAt < :eventTime',
      'attribute_not_exists(rolesUpdatedAt) OR rolesUpdatedAt < :rolesUpdatedAt',
    ]);
  });

  it('a status->ACTIVE event with no contactChannels field does not clear the stored contactChannels (P7 regression)', async () => {
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    await handler(
      buildSqsEvent({
        ...VALID_ENVELOPE,
        payload: { deptId: 'NICHOLS', memberId: 'mbr-102', status: 'ACTIVE', active: true },
      }),
    );

    const updateCall = send.mock.calls[0]?.[0] as {
      input: { UpdateExpression: string; ExpressionAttributeValues: Record<string, unknown> };
    };
    expect(updateCall.input.UpdateExpression).not.toContain('contactChannels');
    expect(updateCall.input.ExpressionAttributeValues[':contactChannels']).toBeUndefined();
    expect(updateCall.input.ExpressionAttributeValues[':value']).toBe(true);
  });

  it('discards a stale/redelivered event (ConditionalCheckFailedException) without throwing (last-writer-wins)', async () => {
    const { ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
    const eventTime = Date.parse(VALID_ENVELOPE.eventTime);
    const send = vi.fn((command: { constructor: { name: string } }) =>
      command.constructor.name === 'GetCommand'
        ? Promise.resolve({ Item: { pushContactsUpdatedAt: eventTime, contactVersion: 4 } })
        : Promise.reject(new ConditionalCheckFailedException({ message: 'stale', $metadata: {} })),
    );
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    const result = await handler(buildSqsEvent(VALID_ENVELOPE));
    expect(result).toEqual({ batchItemFailures: [] });
    // The redelivered push entries are no newer than what is stored: nothing is written.
    expect(contactWrite(send)).toBeUndefined();
  });

  describe('contact projection (design review C2)', () => {
    const PHONE_EVENT = {
      ...VALID_ENVELOPE,
      eventTime: '2026-09-14T00:00:05.000Z',
      payload: { deptId: 'NICHOLS', memberId: 'mbr-102', phone: '+12035550100' },
    };

    function storedSnapshot(item: Record<string, unknown>) {
      return vi.fn((command: { constructor: { name: string } }) =>
        Promise.resolve(command.constructor.name === 'GetCommand' ? { Item: item } : {}),
      );
    }

    it('projects phone into SMS and VOICE entries and keeps the registered PUSH devices', async () => {
      const push = { channel: 'PUSH', platform: 'APNS', token: 'tok-1', valid: true };
      const send = storedSnapshot({ contactChannels: [push], contactVersion: 2 });
      vi.doMock('./dynamoClient.js', () => ({
        createDynamoClient: () => ({ send }),
        readAlertingConfig: () => ({ tableName: 'alerting-table' }),
      }));
      const { handler } = await import('./memberUpdatedHandler.js');
      await handler(buildSqsEvent(PHONE_EVENT));

      const write = contactWrite(send)!;
      expect(write.ExpressionAttributeValues[':contactChannels']).toEqual([
        push,
        { channel: 'SMS', phoneNumber: '+12035550100', valid: true },
        { channel: 'VOICE', phoneNumber: '+12035550100', valid: true },
      ]);
      expect(write.ConditionExpression).toBe('contactVersion = :version');
      expect(write.ExpressionAttributeValues[':version']).toBe(2);
      expect(write.ExpressionAttributeValues[':nextVersion']).toBe(3);
      expect(write.UpdateExpression).toContain('phoneUpdatedAt = :eventTime');
      expect(write.UpdateExpression).not.toContain('pushContactsUpdatedAt');
    });

    it('a push-token event replaces only the PUSH entries and keeps the phone entries', async () => {
      const sms = { channel: 'SMS', phoneNumber: '+12035550100', valid: true };
      const voice = { channel: 'VOICE', phoneNumber: '+12035550100', valid: true };
      const send = storedSnapshot({
        contactChannels: [{ channel: 'PUSH', token: 'old', valid: true }, sms, voice],
        contactVersion: 7,
      });
      vi.doMock('./dynamoClient.js', () => ({
        createDynamoClient: () => ({ send }),
        readAlertingConfig: () => ({ tableName: 'alerting-table' }),
      }));
      const { handler } = await import('./memberUpdatedHandler.js');
      await handler(buildSqsEvent(VALID_ENVELOPE));

      expect(contactWrite(send)!.ExpressionAttributeValues[':contactChannels']).toEqual([
        ...VALID_ENVELOPE.payload.contactChannels,
        sms,
        voice,
      ]);
    });

    it('a newer push event does not make an older phone event stale (per-group timestamps)', async () => {
      const send = storedSnapshot({
        contactChannels: [{ channel: 'PUSH', token: 'tok-1' }],
        pushContactsUpdatedAt: Date.parse('2026-09-14T01:00:00.000Z'),
        contactVersion: 1,
      });
      vi.doMock('./dynamoClient.js', () => ({
        createDynamoClient: () => ({ send }),
        readAlertingConfig: () => ({ tableName: 'alerting-table' }),
      }));
      const { handler } = await import('./memberUpdatedHandler.js');
      await handler(buildSqsEvent(PHONE_EVENT));

      const write = contactWrite(send);
      expect(write?.ExpressionAttributeValues[':contactChannels']).toEqual([
        { channel: 'PUSH', token: 'tok-1' },
        { channel: 'SMS', phoneNumber: '+12035550100', valid: true },
        { channel: 'VOICE', phoneNumber: '+12035550100', valid: true },
      ]);
    });

    it('re-reads and retries when a concurrent contact write wins the version race', async () => {
      const { ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
      let gets = 0;
      let updates = 0;
      const send = vi.fn((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'GetCommand') {
          gets += 1;
          return Promise.resolve({
            Item: {
              contactChannels:
                gets === 1 ? [] : [{ channel: 'PUSH', token: 'tok-registered-meanwhile' }],
              contactVersion: gets,
            },
          });
        }
        updates += 1;
        return updates === 1
          ? Promise.reject(new ConditionalCheckFailedException({ message: 'race', $metadata: {} }))
          : Promise.resolve({});
      });
      vi.doMock('./dynamoClient.js', () => ({
        createDynamoClient: () => ({ send }),
        readAlertingConfig: () => ({ tableName: 'alerting-table' }),
      }));
      const { handler } = await import('./memberUpdatedHandler.js');
      await handler(buildSqsEvent(PHONE_EVENT));

      const writes = (send.mock.calls.map((call) => call[0]) as unknown as SentUpdate[])
        .filter((command) => command.input.ExpressionAttributeValues?.[':contactChannels'])
        .map((command) => command.input);
      expect(writes).toHaveLength(2);
      // The retry merged onto what the concurrent writer stored: its device is not lost.
      expect(writes[1]!.ExpressionAttributeValues[':contactChannels']).toEqual([
        { channel: 'PUSH', token: 'tok-registered-meanwhile' },
        { channel: 'SMS', phoneNumber: '+12035550100', valid: true },
        { channel: 'VOICE', phoneNumber: '+12035550100', valid: true },
      ]);
      expect(writes[1]!.ExpressionAttributeValues[':version']).toBe(2);
    });

    it('ignores an empty phone rather than projecting a blank target', async () => {
      const send = vi.fn().mockResolvedValue({});
      vi.doMock('./dynamoClient.js', () => ({
        createDynamoClient: () => ({ send }),
        readAlertingConfig: () => ({ tableName: 'alerting-table' }),
      }));
      const { handler } = await import('./memberUpdatedHandler.js');
      await handler(
        buildSqsEvent({ ...PHONE_EVENT, payload: { ...PHONE_EVENT.payload, phone: '  ' } }),
      );
      expect(send).not.toHaveBeenCalled();
    });
  });

  it('emits SnapshotPropagationLatencyMs with the elapsed ms from eventTime to now (AC5)', async () => {
    vi.setSystemTime(new Date('2026-09-14T00:00:07.000Z'));
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./memberUpdatedHandler.js');

    await handler(buildSqsEvent(VALID_ENVELOPE));

    const emitted = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.SnapshotPropagationLatencyMs !== undefined);
    expect(emitted?.SnapshotPropagationLatencyMs).toBe(7000);
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  it('clamps a future eventTime (clock skew) to 0 and logs a warning instead of throwing', async () => {
    vi.setSystemTime(new Date('2026-09-13T23:59:00.000Z'));
    const send = vi.fn().mockResolvedValue({});
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { handler } = await import('./memberUpdatedHandler.js');

    const result = await handler(buildSqsEvent(VALID_ENVELOPE));

    expect(result).toEqual({ batchItemFailures: [] });
    const emitted = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.SnapshotPropagationLatencyMs !== undefined);
    expect(emitted?.SnapshotPropagationLatencyMs).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('future_event_time'));
    logSpy.mockRestore();
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('rethrows a non-conditional DynamoDB failure (never swallows) so SQS retries/DLQs', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
    vi.doMock('./dynamoClient.js', () => ({
      createDynamoClient: () => ({ send }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { handler } = await import('./memberUpdatedHandler.js');
    await expect(handler(buildSqsEvent(VALID_ENVELOPE))).rejects.toThrow(
      'ProvisionedThroughputExceededException',
    );
  });
});
