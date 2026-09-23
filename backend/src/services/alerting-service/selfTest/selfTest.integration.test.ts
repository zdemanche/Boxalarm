import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SNSClient } from '@aws-sdk/client-sns';
import type { DynamoDBStreamEvent } from 'aws-lambda';

const TABLE_NAME = 'alerting-table';

function selfTestDispatchInsertEvent(dispatchId: string, testId: string): DynamoDBStreamEvent {
  return {
    Records: [
      {
        eventName: 'INSERT',
        eventID: 'ev-selftest-int',
        dynamodb: {
          NewImage: {
            pk: { S: `DEPT#NICHOLS#DISPATCH#${dispatchId}` },
            sk: { S: 'METADATA' },
            entityType: { S: 'DISPATCH_ALERT' },
            dispatchId: { S: dispatchId },
            deptId: { S: 'NICHOLS' },
            incidentType: { S: 'SELF_TEST' },
            narrative: { S: 'Synthetic self-test dispatch' },
            isTest: { BOOL: true },
            sourceSystem: { S: 'SELF_TEST' },
            targetMemberId: { S: 'mbr-int-1' },
            selfTestId: { S: testId },
            channelsTested: { L: [{ S: 'PUSH' }, { S: 'SMS' }] },
          },
        },
      },
    ],
  } as unknown as DynamoDBStreamEvent;
}

describe('self-test through the real ingress -> idempotency -> fan-out pipeline (real DynamoDB, AC1/AC3/AC4)', () => {
  let container: StartedLocalStackContainer;
  let docClient: DynamoDBDocumentClient;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    container = await new LocalstackContainer('localstack/localstack:4').start();
    const client = new DynamoDBClient({
      endpoint: container.getConnectionUri(),
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    docClient = DynamoDBDocumentClient.from(client);

    await client.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
    process.env = { ...originalEnv };
  });

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = TABLE_NAME;
    process.env.ALERTING_TOPIC_ARN = 'arn:aws:sns:us-east-1:1:boxalarm-dev-alerting-topic.fifo';
  });

  it('creates the DISPATCH_ALERT via the real idempotent write, then fans out only to the target member and writes a distinct SELF_TEST_RUN item — never a real roster scan (AC1/AC3/AC4, side-effect-free per AC4)', async () => {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: 'DEPT#NICHOLS#ELIGIBILITY',
          sk: 'MEMBER#mbr-int-1',
          entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
          memberId: 'mbr-int-1',
          active: true,
          quals: [],
          roles: [],
          contactChannels: [
            { channel: 'PUSH', token: 'tok-int-1', platform: 'APNS', valid: true },
            { channel: 'sms', token: '+15551230001' },
          ],
          availabilityState: 'AVAILABLE',
          snapshotUpdatedAt: 1000,
        },
      }),
    );
    // A second real roster member proves the self-test never fans out beyond targetMemberId.
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: 'DEPT#NICHOLS#ELIGIBILITY',
          sk: 'MEMBER#mbr-int-2',
          entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
          memberId: 'mbr-int-2',
          active: true,
          quals: [],
          roles: [],
          contactChannels: [{ channel: 'PUSH', token: 'tok-int-2', platform: 'APNS', valid: true }],
          availabilityState: 'AVAILABLE',
          snapshotUpdatedAt: 1000,
        },
      }),
    );

    const { createManualDispatch } = await import('../dispatches/repository.js');
    const { deriveIngressIdempotencyKey } = await import('../dispatches/dispatchIngressPort.js');
    const { buildSelfTestDispatch } = await import('./dispatchAdapter.js');
    const { toVerifiedDeptId } = await import('@boxalarm/dept-scope');

    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const testId = `int-${Date.now()}`;
    const dispatch = buildSelfTestDispatch(testId);
    const created = await createManualDispatch(docClient, TABLE_NAME, {
      deptId,
      dispatch,
      idempotencyKey: deriveIngressIdempotencyKey(deptId, 'SELF_TEST', testId),
      dispatchedAt: 1798000000,
      targetMemberId: 'mbr-int-1',
      selfTestId: testId,
      channelsTested: ['PUSH', 'SMS'],
    });
    expect(created.outcome).toBe('created');
    const dispatchId = created.outcome === 'created' ? created.dispatchId : '';

    const snsCalls: unknown[] = [];
    const fakeSns = {
      send: vi.fn((command: unknown) => {
        snsCalls.push((command as { input: unknown }).input);
        return Promise.resolve({ MessageId: 'msg-1' });
      }),
    } as unknown as SNSClient;

    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => docClient };
    });
    vi.doMock('../fanout/snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../fanout/snsClient.js')>();
      return { ...actual, createSnsClient: () => fakeSns };
    });

    const { handler } = await import('../fanout/handler.js');
    await handler(selfTestDispatchInsertEvent(dispatchId, testId));

    expect(snsCalls).toHaveLength(2);
    const receipts = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `DEPT#NICHOLS#DISPATCH#${dispatchId}`, sk: `RECEIPT#mbr-int-2#push#1` },
      }),
    );
    expect(receipts.Item).toBeUndefined();

    const run = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: 'DEPT#NICHOLS#MEMBER#mbr-int-1', sk: `SELFTEST#${testId}` },
      }),
    );
    expect(run.Item?.entityType).toBe('SELF_TEST_RUN');
    expect(run.Item?.overallResult).toBe('PASS');
  }, 60_000);
});
