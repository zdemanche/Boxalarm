import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { PublishCommandInput, SNSClient } from '@aws-sdk/client-sns';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { parseCadUpdateEnvelope } from '../channels/channelEnvelope.js';

const PK = 'DEPT#nichols-fd#DISPATCH#d-1';
const UPDATE_ID = 'a'.repeat(32);

const UPDATE_ITEM = {
  pk: PK,
  sk: `UPDATE#${UPDATE_ID}`,
  entityType: 'DISPATCH_UPDATE',
  deptId: 'nichols-fd',
  dispatchId: 'd-1',
  updateId: UPDATE_ID,
  summary: 'Units: E1, L2, R1',
  receivedAt: 1_800_000_000,
};
const PENDING_KEY = `DEPT#nichols-fd#CAD_UPDATE_PENDING|001800000000#d-1#${UPDATE_ID}`;

describe('CAD update notifier', () => {
  const originalEnv = { ...process.env };
  let items: Map<string, Record<string, unknown>>;
  let published: PublishCommandInput[];

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = 'alerting';
    process.env.ALERTING_TOPIC_ARN = 'arn:aws:sns:us-east-1:1:boxalarm-dev-alerting.fifo';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    published = [];
    items = new Map<string, Record<string, unknown>>([
      [
        `${PK}|METADATA`,
        {
          pk: PK,
          sk: 'METADATA',
          entityType: 'DISPATCH_ALERT',
          incidentType: 'STRUCTURE FIRE',
          address: '123 MAIN ST',
          isTest: false,
          fanOutCompletedAt: 1,
        },
      ],
      [`${PK}|UPDATE#${UPDATE_ID}`, UPDATE_ITEM],
      [PENDING_KEY, { entityType: 'CAD_UPDATE_PENDING' }],
      // Tone-1 receipts are the audience (push + sms for mbr-1, push for mbr-2); a tone-2
      // receipt for mbr-3 does not make mbr-3 a tone-1 member.
      [`${PK}|RECEIPT#mbr-1#push#1`, { pk: PK, sk: 'RECEIPT#mbr-1#push#1' }],
      [`${PK}|RECEIPT#mbr-1#sms#1`, { pk: PK, sk: 'RECEIPT#mbr-1#sms#1' }],
      [`${PK}|RECEIPT#mbr-2#push#1`, { pk: PK, sk: 'RECEIPT#mbr-2#push#1' }],
      [`${PK}|RECEIPT#mbr-3#push#2`, { pk: PK, sk: 'RECEIPT#mbr-3#push#2' }],
    ]);
    const key = (k: Record<string, unknown>) => `${String(k.pk)}|${String(k.sk)}`;
    const ddb = {
      send: vi.fn((command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const input = command.input;
        switch (command.constructor.name) {
          case 'GetCommand':
            return Promise.resolve({ Item: items.get(key(input.Key as Record<string, unknown>)) });
          case 'QueryCommand':
            return Promise.resolve({
              Items: [...items.values()].filter((i) => String(i.sk).startsWith('RECEIPT#')),
            });
          case 'PutCommand': {
            const item = input.Item as Record<string, unknown>;
            if (items.has(key(item))) {
              return Promise.reject(
                new ConditionalCheckFailedException({ message: 'x', $metadata: {} }),
              );
            }
            items.set(key(item), item);
            return Promise.resolve({});
          }
          case 'UpdateCommand': {
            const k = key(input.Key as Record<string, unknown>);
            const field = String(input.UpdateExpression).includes('notifiedAt')
              ? 'notifiedAt'
              : 'sentAt';
            items.set(k, { ...items.get(k), [field]: 1 });
            return Promise.resolve({});
          }
          case 'DeleteCommand':
            items.delete(key(input.Key as Record<string, unknown>));
            return Promise.resolve({});
          default:
            return Promise.reject(new Error(command.constructor.name));
        }
      }),
    } as unknown as DynamoDBDocumentClient;
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../eligibility/dynamoClient.js')>()),
      createDynamoClient: () => ddb,
    }));
    vi.doMock('../fanout/snsClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../fanout/snsClient.js')>()),
      createSnsClient: () =>
        ({
          send: vi.fn((command: { input: PublishCommandInput }) => {
            published.push(command.input);
            return Promise.resolve({});
          }),
        }) as unknown as SNSClient,
    }));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  const NOTICE = { deptId: 'nichols-fd', dispatchId: 'd-1', updateId: UPDATE_ID };

  async function run(notice: Record<string, unknown> = NOTICE) {
    const { handler } = await import('./updateNotifierHandler.js');
    return handler(notice as never);
  }

  it('waits for tone-1 fan-out: without fanOutCompletedAt it throws (async retry) and sends nothing', async () => {
    items.set(`${PK}|METADATA`, { ...items.get(`${PK}|METADATA`), fanOutCompletedAt: undefined });
    await expect(run()).rejects.toThrow('has not completed');
    expect(published).toEqual([]);
  });

  it('pushes one non-escalating UPDATE to each member tone 1 paged, push channel only', async () => {
    await run();
    expect(published).toHaveLength(2);
    for (const input of published) {
      expect(input.MessageAttributes?.channel?.StringValue).toBe('push');
      expect(input.MessageGroupId).toBe('d-1');
      // The channel worker's own parser accepts it (the producer/worker contract).
      const payload = parseCadUpdateEnvelope(input.Message ?? '', 'push');
      expect(payload).toMatchObject({
        alertKind: 'dispatch_update',
        updateId: UPDATE_ID,
        summary: 'Units: E1, L2, R1',
        address: '123 MAIN ST',
      });
      expect(
        (JSON.parse(input.Message ?? '{}') as { payload: Record<string, unknown> }).payload
          .toneSequence,
      ).toBeUndefined();
    }
  });

  it('stamps notifiedAt on the update and clears its pending marker', async () => {
    await run();
    expect(items.get(`${PK}|UPDATE#${UPDATE_ID}`)?.notifiedAt).toBe(1);
    expect(items.has(PENDING_KEY)).toBe(false);
  });

  it('a retried invoke sends nothing twice (exactly once per update per member)', async () => {
    await run();
    await run();
    expect(published).toHaveLength(2);
  });

  it('sends nothing for an unknown update or a test dispatch, and refuses a malformed notice', async () => {
    await run({ ...NOTICE, updateId: 'b'.repeat(32) });
    items.set(`${PK}|METADATA`, { ...items.get(`${PK}|METADATA`), isTest: true });
    await run();
    expect(published).toEqual([]);
    await expect(run({ ...NOTICE, updateId: 'x#y' })).rejects.toThrow('shape validation');
  });

  it('throws (async retry) when a publish fails, after sending the others', async () => {
    const { handler } = await import('./updateNotifierHandler.js');
    const sns = await import('../fanout/snsClient.js');
    let calls = 0;
    vi.spyOn(sns, 'createSnsClient').mockReturnValue({
      send: vi.fn(() =>
        ++calls === 1 ? Promise.reject(new Error('sns down')) : Promise.resolve({}),
      ),
    } as unknown as SNSClient);
    await expect(handler(NOTICE)).rejects.toThrow('update push failed');
  });
});
