import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import {
  CreateTableCommand,
  DynamoDBClient,
  QueryCommand as LowLevelQueryCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { PublishCommandInput, SNSClient } from '@aws-sdk/client-sns';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  DynamoDBStreamEvent,
  SQSEvent,
} from 'aws-lambda';
import { mergeSources, withWebhookKey } from '../../platform-service/cadSources/model.js';

/**
 * The CAD webhook chain end to end against a real DynamoDB (LocalStack), the same pattern as
 * fanout/manualDispatchChain.integration.test.ts:
 *
 *   chief's saved CAD_INGRESS value (the platform model's exact stored shape)
 *   -> the REAL alerting projection consumer -> CAD_INGRESS_COPY
 *   -> the REAL signed webhook handler -> DISPATCH_ALERT (no receipts, no publish)
 *   -> the REAL stream fan-out on that INSERT -> push AND sms for every member at tone 1.
 *
 * Every seam between the domains is crossed with real code on both sides; only SNS, the
 * scheduler and Secrets Manager are stubbed.
 */

const TABLE_NAME = 'alerting-table';
const DEPT = 'nichols-fd';
const MEMBERS = ['mbr-1', 'mbr-2'] as const;
const KEY = 'k'.repeat(64);

describe('CAD webhook -> DISPATCH_ALERT -> stream fan-out pages every member at tone 1', () => {
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

  async function wire(published: PublishCommandInput[]): Promise<void> {
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../eligibility/dynamoClient.js')>()),
      createDynamoClient: () => docClient,
    }));
    vi.doMock('../fanout/snsClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../fanout/snsClient.js')>()),
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
    const keys = await import('./webhookKeys.js');
    keys.resetWebhookKeyCache({
      send: vi.fn().mockResolvedValue({ SecretString: JSON.stringify({ current: KEY }) }),
    } as unknown as SecretsManagerClient);
  }

  /** The chief's save, in the stored shape, delivered as the bus event the rule forwards. */
  async function projectSourceConfig(): Promise<void> {
    const saved = mergeSources(
      [
        {
          sourceId: 'county',
          label: 'County CAD',
          enabled: true,
          emailEnabled: false,
          allowedSenders: [],
          webhookEnabled: true,
          parserFields: {
            incidentNumber: { label: 'INC' },
            dispatchTime: { label: 'TIME' },
            incidentType: { label: 'TYPE' },
            address: { label: 'ADDR' },
          },
        },
      ],
      [],
    );
    const value = {
      sources: withWebhookKey(saved.sources, 'county', {
        keyId: `${DEPT}.county`,
        secretName: 'boxalarm-dev-cad-webhook-nichols-fd-county',
        rotatedAt: '2026-09-30T00:00:00.000Z',
      }),
    };
    const { handler } = await import('./sourceCopyHandler.js');
    const result = await handler({
      Records: [
        {
          messageId: 'cfg-1',
          body: JSON.stringify({
            detail: {
              eventType: 'platform.config.updated',
              eventTime: new Date().toISOString(),
              payload: { configType: 'CAD_INGRESS', deptId: DEPT, version: 1, value },
            },
          }),
        },
      ],
    } as unknown as SQSEvent);
    expect(result.batchItemFailures).toEqual([]);
  }

  function signedEvent(body: string, timestamp = Math.floor(Date.now() / 1000)) {
    const ts = String(timestamp);
    const signature = createHmac('sha256', KEY).update(`${ts}.`).update(body).digest('hex');
    return {
      version: '2.0',
      routeKey: 'POST /api/v1/alerting/ingress/cad-webhook',
      headers: {
        'x-boxalarm-source': `${DEPT}.county`,
        'x-boxalarm-timestamp': ts,
        'x-boxalarm-signature': `v1=${signature}`,
      },
      isBase64Encoded: false,
      body,
      requestContext: { requestId: `req-${ts}` },
    } as unknown as APIGatewayProxyEventV2;
  }

  async function dispatchAlerts() {
    const { Items } = await lowLevel.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'entityType = :t',
        ExpressionAttributeValues: { ':t': { S: 'DISPATCH_ALERT' } },
        ConsistentRead: true,
      }),
    );
    return Items ?? [];
  }

  it('pages push AND sms for every member at tone 1; a CAD resend does not page again', async () => {
    const published: PublishCommandInput[] = [];
    await wire(published);
    await projectSourceConfig();

    const body = JSON.stringify({
      text: 'INC: 2026-4471\nTIME: 09/30/2026 03:12\nTYPE: STRUCTURE FIRE\nADDR: 123 MAIN ST, NICHOLS',
    });
    const { handler: webhook } = await import('./webhookHandler.js');
    const accepted = (await webhook(
      signedEvent(body),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;
    expect(accepted.statusCode).toBe(202);
    const { dispatchId } = JSON.parse(accepted.body ?? '{}') as { dispatchId: string };

    const alerts = await dispatchAlerts();
    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!;
    expect(alert.sourceSystem?.S).toBe('CAD');
    expect(alert.ingressChannel?.S).toBe('cad-webhook');
    expect(alert.address?.S).toBe('123 MAIN ST, NICHOLS');
    expect(alert.cadParserVersion?.N).toBe('1');
    // The webhook wrote no receipt and published nothing: the stream fan-out is the producer.
    expect(published).toEqual([]);

    const { handler: fanOut } = await import('../fanout/handler.js');
    const stream = {
      Records: [
        {
          eventID: `ev-${dispatchId}`,
          eventName: 'INSERT',
          dynamodb: { SequenceNumber: '100', NewImage: alert },
        },
      ],
    } as unknown as DynamoDBStreamEvent;
    expect(await fanOut(stream)).toEqual({ batchItemFailures: [] });

    const pages = published
      .map((input) => {
        const payload = (JSON.parse(input.Message ?? '{}') as { payload: Record<string, unknown> })
          .payload;
        return `${String(payload.memberId)}#${String(payload.channel)}#${String(payload.toneSequence)}`;
      })
      .sort();
    expect(pages).toEqual(
      MEMBERS.flatMap((memberId) => [`${memberId}#push#1`, `${memberId}#sms#1`]).sort(),
    );
    const { Items: receipts } = await lowLevel.send(
      new LowLevelQueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :r)',
        ExpressionAttributeValues: {
          ':pk': { S: `DEPT#${DEPT}#DISPATCH#${dispatchId}` },
          ':r': { S: 'RECEIPT#' },
        },
        ConsistentRead: true,
      }),
    );
    expect(receipts).toHaveLength(MEMBERS.length * 2);

    // The CAD resends the same dispatch, freshly signed: a duplicate, not a second page.
    const resend = (await webhook(
      signedEvent(body, Math.floor(Date.now() / 1000) + 1),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;
    expect(resend.statusCode).toBe(200);
    expect(await dispatchAlerts()).toHaveLength(1);

    // And the identical request replayed is refused outright.
    const replay = (await webhook(
      signedEvent(body, Math.floor(Date.now() / 1000) + 1),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;
    expect(replay.statusCode).toBe(409);
  }, 90_000);
});
