import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import {
  CreateTableCommand,
  DynamoDBClient,
  GetItemCommand,
  QueryCommand as LowLevelQueryCommand,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { PublishCommandInput, SNSClient } from '@aws-sdk/client-sns';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
  DynamoDBStreamEvent,
} from 'aws-lambda';

/**
 * Design review C1, end to end against a real DynamoDB (LocalStack): the REAL manual-dispatch
 * handler writes the dispatch, then the REAL stream fan-out runs on the record the table stream
 * would carry. Every eligible member must be published on push and on SMS at tone 1.
 *
 * Before the fix the handler also ran a synchronous fan-out that pre-wrote the tone-1 receipts
 * with sentAt under the same exactly-once key and never published; the stream fan-out then
 * skipped every member as DuplicateSkipped and nobody was paged until tone 2.
 */

const TABLE_NAME = 'alerting-table';
const DEPT = 'NICHOLS';
const MEMBERS = ['mbr-1', 'mbr-2', 'mbr-3'] as const;

interface AuthorizerContext {
  readonly sub: string;
  readonly deptId: string;
  readonly 'cognito:groups': string;
}

function manualDispatchEvent(
  externalDispatchId: string,
): APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext> {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/alerting/dispatches',
    rawPath: '/api/v1/alerting/dispatches',
    rawQueryString: '',
    headers: { authorization: 'Bearer officer-token' },
    isBase64Encoded: false,
    body: JSON.stringify({
      incidentType: 'STRUCTURE_FIRE',
      address: '123 Main St',
      crossStreets: 'Main & Elm',
      narrative: 'Smoke showing',
      externalDispatchId,
    }),
    requestContext: {
      requestId: `req-${externalDispatchId}`,
      authorizer: { lambda: { sub: 'officer-1', deptId: DEPT, 'cognito:groups': 'OFFICER' } },
    },
  } as unknown as APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;
}

describe('C1: manual dispatch -> stream fan-out pages every eligible member at tone 1', () => {
  let container: StartedLocalStackContainer;
  let lowLevel: DynamoDBClient;
  let docClient: DynamoDBDocumentClient;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    container = await new LocalstackContainer('localstack/localstack:3').start();
    lowLevel = new DynamoDBClient({
      endpoint: container.getConnectionUri(),
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    docClient = DynamoDBDocumentClient.from(lowLevel);
    await lowLevel.send(
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
    for (const memberId of MEMBERS) {
      await docClient.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            pk: `DEPT#${DEPT}#ELIGIBILITY`,
            sk: `MEMBER#${memberId}`,
            entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
            memberId,
            active: true,
            quals: [],
            roles: ['MEMBER'],
            availabilityState: 'AVAILABLE',
            contactChannels: [
              { channel: 'PUSH', platform: 'APNS', token: `tok-${memberId}`, valid: true },
              { channel: 'SMS', phoneNumber: '+12035550100', valid: true },
              { channel: 'VOICE', phoneNumber: '+12035550100', valid: true },
            ],
            snapshotUpdatedAt: 1000,
          },
        }),
      );
    }
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = TABLE_NAME;
    process.env.ALERTING_DISPATCHES_TABLE_NAME = TABLE_NAME;
    process.env.ALERTING_TOPIC_ARN = 'arn:aws:sns:us-east-1:1:boxalarm-dev-alerting.fifo';
    process.env.ESCALATION_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:escalation';
    process.env.TONE_EVALUATOR_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:tone-evaluator';
    process.env.ESCALATION_SCHEDULER_ROLE_ARN = 'arn:aws:iam::1:role/scheduler';
    process.env.ESCALATION_SCHEDULE_GROUP_NAME = 'boxalarm-dev-alerting-escalation';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  function wireClients(published: PublishCommandInput[]): void {
    vi.doMock('../dispatches/authorization.js', () => ({
      getVerifiedPermissionsClient: () => ({}),
      readAuthorizationConfig: () => ({ policyStoreId: 'store-1' }),
      authorizeManualDispatchSubmission: vi.fn().mockResolvedValue('ALLOWED'),
    }));
    vi.doMock('../dispatches/dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../dispatches/dynamoClient.js')>()),
      getDynamoClient: () => docClient,
    }));
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../eligibility/dynamoClient.js')>()),
      createDynamoClient: () => docClient,
    }));
    vi.doMock('./snsClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./snsClient.js')>()),
      createSnsClient: () =>
        ({
          send: vi.fn((command: { input: PublishCommandInput }) => {
            published.push(command.input);
            return Promise.resolve({ MessageId: `msg-${published.length}` });
          }),
        }) as unknown as SNSClient,
    }));
    vi.doMock('../escalation/scheduleEscalation.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../escalation/scheduleEscalation.js')>()),
      getSchedulerClient: () =>
        ({ send: vi.fn().mockResolvedValue({}) }) as unknown as SchedulerClient,
    }));
  }

  async function createDispatch(externalDispatchId: string): Promise<string> {
    const { handler } = await import('../dispatches/handler.js');
    const response = (await handler(
      manualDispatchEvent(externalDispatchId),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;
    expect(response.statusCode).toBe(201);
    return (JSON.parse(response.body ?? '{}') as { dispatchId: string }).dispatchId;
  }

  /** The INSERT record the table stream carries for the DISPATCH_ALERT the handler wrote. */
  async function streamInsertFor(dispatchId: string): Promise<DynamoDBStreamEvent> {
    const { Item } = await lowLevel.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { pk: { S: `DEPT#${DEPT}#DISPATCH#${dispatchId}` }, sk: { S: 'METADATA' } },
      }),
    );
    expect(Item?.entityType?.S).toBe('DISPATCH_ALERT');
    return {
      Records: [
        {
          eventID: `ev-${dispatchId}`,
          eventName: 'INSERT',
          dynamodb: { SequenceNumber: '100', NewImage: Item },
        },
      ],
    } as unknown as DynamoDBStreamEvent;
  }

  async function receiptsFor(dispatchId: string) {
    const result = await lowLevel.send(
      new LowLevelQueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :receipt)',
        ExpressionAttributeValues: {
          ':pk': { S: `DEPT#${DEPT}#DISPATCH#${dispatchId}` },
          ':receipt': { S: 'RECEIPT#' },
        },
        ConsistentRead: true,
      }),
    );
    return result.Items ?? [];
  }

  function publishedPages(published: readonly PublishCommandInput[]): string[] {
    return published
      .map((input) => {
        const payload = (JSON.parse(input.Message ?? '{}') as { payload: Record<string, unknown> })
          .payload;
        return `${String(payload.memberId)}#${String(payload.channel)}#${String(payload.toneSequence)}`;
      })
      .sort();
  }

  function loggedMetric(name: string): boolean {
    return vi
      .mocked(console.log)
      .mock.calls.some(([line]) => String(line).includes(`"Name":"${name}"`));
  }

  it('the manual handler writes no receipt; the stream fan-out publishes push AND sms for every member at tone 1', async () => {
    const published: PublishCommandInput[] = [];
    wireClients(published);

    const dispatchId = await createDispatch(`op-${Date.now()}`);
    expect(await receiptsFor(dispatchId)).toEqual([]);

    const { handler: fanOut } = await import('./handler.js');
    expect(await fanOut(await streamInsertFor(dispatchId))).toEqual({ batchItemFailures: [] });

    expect(publishedPages(published)).toEqual(
      MEMBERS.flatMap((memberId) => [`${memberId}#push#1`, `${memberId}#sms#1`]).sort(),
    );
    const receipts = await receiptsFor(dispatchId);
    expect(receipts).toHaveLength(MEMBERS.length * 2);
    for (const receipt of receipts) {
      expect(receipt.sentAt?.N).toBeDefined();
      expect(receipt.toneSequence?.N).toBe('1');
    }
    expect(loggedMetric('DuplicateSkipped')).toBe(false);
  }, 60_000);

  it('a tone-1 receipt pre-written by any other writer is caught on the first pass (DuplicateSkippedFirstPass is alarmed)', async () => {
    const published: PublishCommandInput[] = [];
    wireClients(published);

    const dispatchId = await createDispatch(`op-pre-${Date.now()}`);
    // The exact shape the removed synchronous fan-out wrote: sentAt set, never published.
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `DEPT#${DEPT}#DISPATCH#${dispatchId}`,
          sk: 'RECEIPT#mbr-1#push#1',
          entityType: 'DELIVERY_RECEIPT',
          dispatchId,
          memberId: 'mbr-1',
          channel: 'push',
          toneSequence: 1,
          sentAt: 1798000000,
          idempotencyKey: `${dispatchId}#1#mbr-1#push`,
        },
      }),
    );

    const { handler: fanOut } = await import('./handler.js');
    await fanOut(await streamInsertFor(dispatchId));

    expect(publishedPages(published)).not.toContain('mbr-1#push#1');
    expect(loggedMetric('DuplicateSkippedFirstPass')).toBe(true);
  }, 60_000);
});
