import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

vi.mock('../eligibility/dynamoClient.js', () => ({
  createDynamoClient: vi.fn(),
  readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
}));

vi.mock('../fanout/snsClient.js', () => ({
  createSnsClient: vi.fn(() => ({})),
  readFanOutTopicConfig: vi.fn(() => ({ topicArn: 'arn:aws:sns:us-east-1:1:alerting-topic.fifo' })),
}));

vi.mock('./scheduleEscalation.js', () => ({
  getSchedulerClient: vi.fn(() => ({})),
  createEscalationSchedule: vi.fn().mockResolvedValue('schedule-name'),
}));

interface MutualAidResult {
  readonly requested: boolean;
  readonly officersNotified: number;
  readonly adapterUsed: string;
}
const requestMutualAid = vi
  .fn<(...args: unknown[]) => Promise<MutualAidResult>>()
  .mockResolvedValue({
    requested: true,
    officersNotified: 1,
    adapterUsed: 'OFFICER_MANUAL_PROMPT',
  });
vi.mock('./mutualAidPort.js', () => ({
  requestMutualAid: (...args: unknown[]) => requestMutualAid(...args),
}));

interface FakeItem {
  pk: string;
  sk: string;
  [key: string]: unknown;
}

function createFakeDdb(
  seed: readonly FakeItem[],
  options: { readonly failReceiptForMemberId?: string } = {},
): {
  send: DynamoDBDocumentClient['send'];
  sns: { send: ReturnType<typeof vi.fn> };
  items: Map<string, FakeItem>;
} {
  const items = new Map<string, FakeItem>();
  for (const item of seed) {
    items.set(`${item.pk}#${item.sk}`, item);
  }
  const sns = { send: vi.fn().mockResolvedValue({}) };
  const send = vi.fn((command: unknown) => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    if (name === 'GetCommand') {
      const key = (input as { Key: { pk: string; sk: string } }).Key;
      return Promise.resolve({ Item: items.get(`${key.pk}#${key.sk}`) });
    }
    if (name === 'QueryCommand') {
      const query = input as { ExpressionAttributeValues: Record<string, unknown> };
      const pk = query.ExpressionAttributeValues[':pk'];
      const prefix = query.ExpressionAttributeValues[':skPrefix'] as string | undefined;
      return Promise.resolve({
        Items: [...items.values()].filter(
          (item) => item.pk === pk && (!prefix || item.sk.startsWith(prefix)),
        ),
      });
    }
    if (name === 'PutCommand') {
      const put = input as { Item: FakeItem; ConditionExpression?: string };
      const key = `${put.Item.pk}#${put.Item.sk}`;
      if (
        options.failReceiptForMemberId &&
        put.Item.entityType === 'DELIVERY_RECEIPT' &&
        put.Item.memberId === options.failReceiptForMemberId
      ) {
        throw new Error('ddb unavailable');
      }
      if (put.ConditionExpression && items.has(key)) {
        const error = new Error('conditional check failed');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
      items.set(key, put.Item);
      return Promise.resolve({});
    }
    if (name === 'UpdateCommand') {
      const update = input as {
        Key: { pk: string; sk: string };
        ExpressionAttributeValues: Record<string, unknown>;
      };
      const key = `${update.Key.pk}#${update.Key.sk}`;
      const existing = items.get(key) ?? { pk: update.Key.pk, sk: update.Key.sk };
      items.set(key, {
        ...existing,
        currentToneSequence: update.ExpressionAttributeValues[':tone'],
        toneLadderStatus: update.ExpressionAttributeValues[':status'],
      });
      return Promise.resolve({});
    }
    if (name === 'TransactWriteCommand') {
      const transactItems = input.TransactItems as ReadonlyArray<Record<string, unknown>>;
      const failedIndex = transactItems.findIndex((txItem) => {
        const put = txItem.Put as { Item: FakeItem; ConditionExpression?: string } | undefined;
        return (
          put?.ConditionExpression === 'attribute_not_exists(pk)' &&
          items.has(`${put.Item.pk}#${put.Item.sk}`)
        );
      });
      if (failedIndex !== -1) {
        const error = new Error('conditional check failed');
        error.name = 'TransactionCanceledException';
        throw error;
      }
      for (const txItem of transactItems) {
        if (txItem.Put) {
          const put = txItem.Put as { Item: FakeItem };
          items.set(`${put.Item.pk}#${put.Item.sk}`, put.Item);
        }
      }
      return Promise.resolve({});
    }
    throw new Error(`fake ddb: unsupported command ${name}`);
  });
  return { send, sns, items };
}

const PK = 'DEPT#NICHOLS#DISPATCH#dispatch-1';
const ELIGIBILITY_PK = 'DEPT#NICHOLS#ELIGIBILITY';

const METADATA_ITEM: FakeItem = {
  pk: PK,
  sk: 'METADATA',
  entityType: 'DISPATCH_ALERT',
  dispatchId: 'dispatch-1',
  toneLadderStatus: 'ACTIVE',
  currentToneSequence: 1,
  incidentType: 'STRUCTURE_FIRE',
  address: '1 Main St',
};

const ELIGIBLE_MEMBER: FakeItem = {
  pk: ELIGIBILITY_PK,
  sk: 'MEMBER#mbr-1',
  entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
  memberId: 'mbr-1',
  active: true,
  quals: [],
  roles: [],
  contactChannels: [{ channel: 'PUSH', token: 'tok', platform: 'ios', valid: true }],
  availabilityState: 'AVAILABLE',
  snapshotUpdatedAt: 0,
};

describe('toneEvaluatorHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    requestMutualAid.mockClear();
    process.env.ESCALATION_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:escalation';
    process.env.ESCALATION_SCHEDULER_ROLE_ARN = 'arn:aws:iam::1:role/scheduler';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('fires tone 2 and re-tones the full eligible roster when the predicate is unmet', async () => {
    const { send, sns, items } = createFakeDdb([METADATA_ITEM, ELIGIBLE_MEMBER]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');
    const result = await handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 });

    expect(result).toEqual({ outcome: 'FIRED' });
    expect(sns.send).toHaveBeenCalledTimes(1); // push only — no SMS contact channel registered
    const publishedMessage = JSON.parse(
      (sns.send.mock.calls[0]![0] as { input: { Message: string } }).input.Message,
    ) as { payload: { toneSequence: number } };
    expect(publishedMessage.payload.toneSequence).toBe(2);
    expect(items.get(`${PK}#TONE#2`)).toBeDefined();
    expect(items.get(`${PK}#METADATA`)?.currentToneSequence).toBe(2);
  });

  it('does not re-fire a tone that already ran (at-least-once Scheduler delivery)', async () => {
    const { send, sns, items } = createFakeDdb([
      METADATA_ITEM,
      ELIGIBLE_MEMBER,
      {
        pk: PK,
        sk: 'TONE#2',
        entityType: 'TONE_EVENT_GUARD',
        dispatchId: 'dispatch-1',
        toneSequence: 2,
      },
    ]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');
    const result = await handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 });

    expect(result).toEqual({ outcome: 'SKIPPED_ALREADY_FIRED' });
    expect(sns.send).not.toHaveBeenCalled();
    void items;
  });

  it('skips firing when the responder predicate is already met', async () => {
    const roster: FakeItem = {
      pk: PK,
      sk: 'ROSTER#mbr-1',
      entityType: 'DISPATCH_ROSTER_ENTRY',
      memberId: 'mbr-1',
      ackStatus: 'RESPONDING',
      quals: [],
    };
    const { send, sns } = createFakeDdb([METADATA_ITEM, ELIGIBLE_MEMBER, roster]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');
    const result = await handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 });

    expect(result).toEqual({ outcome: 'SKIPPED_PREDICATE_MET' });
    expect(sns.send).not.toHaveBeenCalled();
  });

  it('requests mutual aid when tone 3 fires with the predicate still unmet', async () => {
    const { send, sns } = createFakeDdb([METADATA_ITEM, ELIGIBLE_MEMBER]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');
    const result = await handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 3 });

    expect(result).toEqual({ outcome: 'FIRED' });
    expect(requestMutualAid).toHaveBeenCalledTimes(1);
    expect(requestMutualAid).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchId: 'dispatch-1',
        deptId: 'NICHOLS',
        reason: 'TONE_3_PREDICATE_UNMET',
      }),
    );
  });

  it('throws and does not advance tone state when a member publish fails (MAJOR #2 regression)', async () => {
    const failingMember: FakeItem = {
      pk: ELIGIBILITY_PK,
      sk: 'MEMBER#mbr-fail',
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      memberId: 'mbr-fail',
      active: true,
      quals: [],
      roles: [],
      contactChannels: [{ channel: 'PUSH', token: 'tok', platform: 'ios', valid: true }],
      availabilityState: 'AVAILABLE',
      snapshotUpdatedAt: 0,
    };
    const { send, sns, items } = createFakeDdb([METADATA_ITEM, ELIGIBLE_MEMBER, failingMember], {
      failReceiptForMemberId: 'mbr-fail',
    });
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');

    await expect(
      handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 }),
    ).rejects.toThrow('ddb unavailable');

    // mbr-1's receipt still gets attempted concurrently despite mbr-fail's failure.
    expect(items.get(`${PK}#RECEIPT#mbr-1#push#2`)).toBeDefined();
    expect(items.get(`${PK}#RECEIPT#mbr-fail#push#2`)).toBeUndefined();
    // The tone must not be marked fired/advanced when a member's page failed to send.
    expect(items.get(`${PK}#METADATA`)?.currentToneSequence).toBe(1);
    expect(items.get(`${PK}#METADATA`)?.toneLadderStatus).toBe('ACTIVE');
  });

  it('does not evaluate a manually halted dispatch', async () => {
    const halted: FakeItem = { ...METADATA_ITEM, toneLadderStatus: 'HALTED_MANUAL' };
    const { send, sns } = createFakeDdb([halted, ELIGIBLE_MEMBER]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    const { createSnsClient } = await import('../fanout/snsClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
    vi.mocked(createSnsClient).mockReturnValue(sns as never);

    const { handler } = await import('./toneEvaluatorHandler.js');
    const result = await handler({ deptId: 'NICHOLS', dispatchId: 'dispatch-1', toneSequence: 2 });

    expect(result).toEqual({ outcome: 'SKIPPED_MANUALLY_HALTED' });
    expect(sns.send).not.toHaveBeenCalled();
  });
});
