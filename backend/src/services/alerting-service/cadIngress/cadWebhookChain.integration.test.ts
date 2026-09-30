import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import {
  CreateTableCommand,
  DynamoDBClient,
  QueryCommand as LowLevelQueryCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import type { EventBridgeClient, PutEventsRequestEntry } from '@aws-sdk/client-eventbridge';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { PublishCommandInput, SNSClient } from '@aws-sdk/client-sns';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  DynamoDBStreamEvent,
  SESEvent,
  SQSEvent,
} from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { mergeSources, withWebhookKey } from '../../platform-service/cadSources/model.js';
import { parseChannelEnvelope, type ChannelName } from '../channels/channelEnvelope.js';

/**
 * The CAD ingress chains end to end against a real DynamoDB (LocalStack) - chain review m6 -
 * every seam crossed with the real code on both sides:
 *
 *   chief's save: the REAL putDepartmentConfig (config + outbox row) -> the REAL platform
 *     outbox drain -> the bus envelope -> the REAL alerting copy consumer -> CAD_INGRESS_COPY
 *   webhook / email: the REAL handlers -> DISPATCH_ALERT (no receipts, no publish)
 *   -> the REAL stream fan-out on that INSERT -> every published page run through the channel
 *     worker's OWN parser (parseChannelEnvelope), the contract that once dead-lettered pages.
 *
 * Only SNS, the scheduler, Secrets Manager, S3 and the Lambda invoke are stubbed.
 */

const TABLE_NAME = 'alerting-table';
const DEPT = 'nichols-fd';
const MEMBERS = ['mbr-1', 'mbr-2'] as const;
const KEY = 'k'.repeat(64);
const EMAIL_DOMAIN = 'cad.nichols.example.org';

describe('CAD ingress chains: config -> ingress -> DISPATCH_ALERT -> fan-out -> channel workers', () => {
  let container: StartedLocalStackContainer;
  let lowLevel: DynamoDBClient;
  let docClient: DynamoDBDocumentClient;
  let emailAddress = '';
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
    process.env.CAD_WEBHOOK_SECRET_PREFIX = 'boxalarm-dev-cad-webhook/';
    process.env.CAD_UPDATE_NOTIFIER_FUNCTION = 'boxalarm-dev-alerting-cad-update-notifier';
    process.env.CAD_MAIL_BUCKET = 'mail';
    process.env.CAD_INGRESS_EMAIL_DOMAIN = EMAIL_DOMAIN;
    process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-dev-platform-bus';
    process.env.PLATFORM_TABLE_NAME = 'platform';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  interface Wiring {
    readonly published: PublishCommandInput[];
    readonly notifierInvokes: unknown[];
    serveMail(raw: string): void;
  }

  async function wire(): Promise<Wiring> {
    const published: PublishCommandInput[] = [];
    const notifierInvokes: unknown[] = [];
    let mail = '';
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
      send: vi.fn().mockResolvedValue({
        SecretString: JSON.stringify({ deptId: DEPT, sourceId: 'county', current: KEY }),
      }),
    } as unknown as SecretsManagerClient);
    (await import('./notifyUpdate.js')).setLambdaClient({
      send: vi.fn((command: { input: { Payload: Uint8Array } }) => {
        notifierInvokes.push(JSON.parse(Buffer.from(command.input.Payload).toString()));
        return Promise.resolve({ StatusCode: 202 });
      }),
    } as unknown as LambdaClient);
    (await import('./emailHandler.js')).setS3Client({
      send: vi.fn(() =>
        Promise.resolve({
          ContentLength: mail.length,
          Body: { transformToByteArray: () => Promise.resolve(Buffer.from(mail, 'latin1')) },
        }),
      ),
    } as unknown as S3Client);
    return {
      published,
      notifierInvokes,
      serveMail: (raw) => {
        mail = raw;
      },
    };
  }

  /**
   * The chief's save: the real platform repository writes the config row and its outbox row;
   * the real platform outbox drain turns that row into the bus entry; the rule delivers the
   * entry to the real alerting copy consumer.
   */
  async function saveSourceThroughTheBus(): Promise<void> {
    const saved = mergeSources(
      [
        {
          sourceId: 'county',
          label: 'County CAD',
          enabled: true,
          emailEnabled: true,
          allowedSenders: ['cad.county.gov'],
          webhookEnabled: true,
          parserFields: {
            incidentNumber: { label: 'INC' },
            incidentType: { label: 'TYPE' },
            address: { label: 'ADDR' },
            units: { label: 'UNITS' },
          },
        },
      ],
      [],
      () => 'tok1234567890abc',
    );
    emailAddress = `dispatch+${DEPT}.county.tok1234567890abc@${EMAIL_DOMAIN}`;
    const value = {
      sources: withWebhookKey(saved.sources, 'county', {
        keyId: `${DEPT}.county`,
        secretName: `boxalarm-dev-cad-webhook/${DEPT}/county`,
        rotatedAt: '2026-09-30T00:00:00.000Z',
      }),
    };
    const platformWrites: {
      input: { TransactItems: { Put: { Item: Record<string, unknown> } }[] };
    }[] = [];
    const { putDepartmentConfig } = await import('../../platform-service/config/repository.js');
    await putDepartmentConfig(
      {
        send: vi.fn((command: (typeof platformWrites)[number]) => {
          platformWrites.push(command);
          return Promise.resolve({});
        }),
      } as unknown as DynamoDBDocumentClient,
      {
        tableName: 'platform',
        deptId: toVerifiedDeptId({ deptId: DEPT }),
        configType: 'CAD_INGRESS',
        value: value,
        actorId: 'chief-1',
        correlationId: 'c-1',
      },
    );
    const outbox = platformWrites[0]!.input.TransactItems.map((t) => t.Put.Item).find(
      (item) => item.eventType === 'platform.config.updated',
    )!;
    const entries: PutEventsRequestEntry[] = [];
    const { createOutboxDrainHandler } = await import('@boxalarm/outbox');
    const drain = createOutboxDrainHandler('platform-service', {
      eventBridgeClient: {
        send: vi.fn((command: { input: { Entries: PutEventsRequestEntry[] } }) => {
          entries.push(...command.input.Entries);
          return Promise.resolve({ Entries: command.input.Entries.map(() => ({ EventId: 'e' })) });
        }),
      } as unknown as EventBridgeClient,
      ddbClient: { send: vi.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient,
    });
    await drain(
      {
        Records: [
          {
            eventName: 'INSERT',
            dynamodb: {
              SequenceNumber: '1',
              NewImage: marshall(outbox, { removeUndefinedValues: true }),
            },
          },
        ],
      } as unknown as DynamoDBStreamEvent,
      {} as never,
      () => undefined,
    );
    const entry = entries[0]!;
    expect(entry.DetailType).toBe('platform.config.updated');
    const { handler } = await import('./sourceCopyHandler.js');
    const result = await handler({
      Records: [
        {
          messageId: 'cfg-1',
          body: JSON.stringify({
            source: entry.Source,
            'detail-type': entry.DetailType,
            detail: JSON.parse(entry.Detail!) as unknown,
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
      requestContext: { requestId: `req-${ts}-${body.length}` },
    } as unknown as APIGatewayProxyEventV2;
  }

  async function postWebhook(body: string, timestamp?: number) {
    const { handler } = await import('./webhookHandler.js');
    const event = signedEvent(body, timestamp);
    return {
      event,
      response: (await handler(
        event,
        {} as never,
        () => undefined,
      )) as APIGatewayProxyStructuredResultV2,
    };
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

  async function alertById(dispatchId: string) {
    return (await dispatchAlerts()).find((a) => a.dispatchId?.S === dispatchId)!;
  }

  /** The stream fan-out on the DISPATCH_ALERT INSERT; returns what each channel worker parses. */
  async function fanOut(published: PublishCommandInput[], dispatchId: string) {
    const alert = await alertById(dispatchId);
    const before = published.length;
    const { handler } = await import('../fanout/handler.js');
    const stream = {
      Records: [
        {
          eventID: `ev-${dispatchId}`,
          eventName: 'INSERT',
          dynamodb: { SequenceNumber: '100', NewImage: alert },
        },
      ],
    } as unknown as DynamoDBStreamEvent;
    expect(await handler(stream)).toEqual({ batchItemFailures: [] });
    return published.slice(before).map((input) => {
      const channel = input.MessageAttributes?.channel?.StringValue as ChannelName;
      return parseChannelEnvelope(input.Message ?? '', channel);
    });
  }

  it('webhook: config over the real bus, a PARSED page every member parses on push and sms, then an UPDATE (no new page), and an identical replay refused', async () => {
    const wiring = await wire();
    await saveSourceThroughTheBus();

    const body = JSON.stringify({
      text: 'INC: 2026-4471\nTYPE: STRUCTURE FIRE\nADDR: 123 MAIN ST, NICHOLS\nUNITS: E1, L2',
    });
    const first = await postWebhook(body);
    expect(first.response.statusCode).toBe(202);
    const { dispatchId } = JSON.parse(first.response.body ?? '{}') as { dispatchId: string };
    expect(wiring.published).toEqual([]);

    const pages = await fanOut(wiring.published, dispatchId);
    expect(pages.map((p) => `${p.memberId}#${p.channel}#${p.toneSequence}`).sort()).toEqual(
      MEMBERS.flatMap((m) => [`${m}#push#1`, `${m}#sms#1`]).sort(),
    );
    for (const page of pages) {
      expect(page).toMatchObject({
        incidentType: 'STRUCTURE FIRE',
        address: '123 MAIN ST, NICHOLS',
      });
    }
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

    // The CAD adds a unit: an UPDATE of the same dispatch, handed to the notifier, never a page.
    const update = JSON.stringify({
      text: 'INC: 2026-4471\nTYPE: STRUCTURE FIRE\nADDR: 123 MAIN ST, NICHOLS\nUNITS: E1, L2, R1',
    });
    const updated = await postWebhook(update, Math.floor(Date.now() / 1000) + 1);
    expect(JSON.parse(updated.response.body ?? '{}')).toMatchObject({
      status: 'updated',
      dispatchId,
    });
    expect(await dispatchAlerts()).toHaveLength(1);
    expect((await alertById(dispatchId)).unitsRequested?.L?.map((u) => u.S)).toEqual([
      'E1',
      'L2',
      'R1',
    ]);
    expect(wiring.notifierInvokes).toEqual([expect.objectContaining({ deptId: DEPT, dispatchId })]);

    // The identical first request replayed is refused outright: its marker committed with it.
    const { handler } = await import('./webhookHandler.js');
    const replay = (await handler(
      first.event,
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;
    expect(replay.statusCode).toBe(409);
  }, 120_000);

  it('webhook RAW: an unparseable authenticated message pages with its text on sms and push', async () => {
    const wiring = await wire();
    await saveSourceThroughTheBus();
    const { response } = await postWebhook(
      'SMOKE BEHIND THE OLD MILL ON RIVER RD, CALLER ON SCENE',
    );
    expect(JSON.parse(response.body ?? '{}')).toMatchObject({ parse: 'RAW' });
    const { dispatchId } = JSON.parse(response.body ?? '{}') as { dispatchId: string };
    const pages = await fanOut(wiring.published, dispatchId);
    expect(pages.length).toBe(MEMBERS.length * 2);
    for (const page of pages) {
      // deliverChannelMessage builds each channel's text as "{type} — {address}".
      expect(`${page.incidentType} — ${page.address}`).toContain(
        'VERIFY: SMOKE BEHIND THE OLD MILL ON RIVER RD',
      );
    }
  }, 120_000);

  it('text-only identity: two identical calls an hour apart both page; a resend inside 10 min does not', async () => {
    const wiring = await wire();
    await saveSourceThroughTheBus();
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const text = JSON.stringify({ text: 'TYPE: MEDICAL\nADDR: 100 ELM ST' }); // no INC
    const before = (await dispatchAlerts()).length;

    expect((await postWebhook(text)).response.statusCode).toBe(202);
    vi.setSystemTime(start + 5 * 60 * 1000);
    expect(JSON.parse((await postWebhook(text)).response.body ?? '{}')).toEqual({
      status: 'duplicate',
    });
    vi.setSystemTime(start + 60 * 60 * 1000);
    const again = await postWebhook(text);
    expect(again.response.statusCode).toBe(202);
    expect((await dispatchAlerts()).length).toBe(before + 2);
    const { dispatchId } = JSON.parse(again.response.body ?? '{}') as { dispatchId: string };
    expect((await fanOut(wiring.published, dispatchId)).length).toBe(MEMBERS.length * 2);
  }, 120_000);

  it('email: an authenticated CAD email pages every member through the same fan-out', async () => {
    const wiring = await wire();
    await saveSourceThroughTheBus();
    const now = Math.floor(Date.now() / 1000);
    wiring.serveMail(
      [
        `DKIM-Signature: v=1; a=rsa-sha256; d=cad.county.gov; s=sel; t=${now}; h=from:to:subject:date; b=abc123`,
        'From: "County Dispatch" <dispatch@cad.county.gov>',
        `To: ${emailAddress}`,
        `Date: ${new Date(now * 1000).toUTCString()}`,
        'Message-ID: <chain-1@cad.county.gov>',
        'Subject: STRUCTURE FIRE',
        'Content-Type: text/plain',
        '',
        'INC: 2026-9001\r\nADDR: 7 PINE RD\r\n',
      ].join('\r\n'),
    );
    const before = new Set((await dispatchAlerts()).map((a) => a.dispatchId?.S));
    const { handler } = await import('./emailHandler.js');
    await handler({
      Records: [
        {
          ses: {
            mail: { messageId: 'ses-chain-1', destination: [emailAddress] },
            receipt: {
              recipients: [emailAddress],
              spfVerdict: { status: 'PASS' },
              dkimVerdict: { status: 'PASS' },
              spamVerdict: { status: 'PASS' },
              virusVerdict: { status: 'PASS' },
              dmarcVerdict: { status: 'PASS' },
            },
          },
        },
      ],
    } as unknown as SESEvent);
    const created = (await dispatchAlerts()).find((a) => !before.has(a.dispatchId?.S))!;
    expect(created).toBeDefined();
    expect(created.ingressChannel?.S).toBe('cad-email');
    expect(created.address?.S).toBe('7 PINE RD');
    const pages = await fanOut(wiring.published, created.dispatchId!.S!);
    expect(pages.map((p) => p.channel).sort()).toEqual(['push', 'push', 'sms', 'sms']);
  }, 120_000);
});
