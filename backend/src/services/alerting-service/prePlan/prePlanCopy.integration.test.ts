import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent } from 'aws-lambda';

const TABLE_NAME = 'alerting-preplan-test';

function sqsEvent(eventType: string, correlationId: string, payload: Record<string, unknown>) {
  return {
    Records: [
      {
        messageId: `msg-${correlationId}`,
        body: JSON.stringify({
          eventId: `evt-${correlationId}`,
          eventTime: '2026-09-06T00:00:00Z',
          eventType,
          source: 'inspections-service',
          correlationId,
          schemaVersion: '1.0',
          payload,
        }),
      },
    ],
  } as unknown as SQSEvent;
}

describe('PRE_PLAN_COPY consumers (real DynamoDB, AC1/AC2)', () => {
  let container: StartedLocalStackContainer;
  let client: DynamoDBDocumentClient;

  beforeAll(async () => {
    container = await new LocalstackContainer('localstack/localstack:4').start();
    const base = new DynamoDBClient({
      endpoint: container.getConnectionUri(),
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await base.send(
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
    client = DynamoDBDocumentClient.from(base);
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = TABLE_NAME;
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => client };
    });
  });

  afterEach(() => {
    vi.doUnmock('../eligibility/dynamoClient.js');
  });

  it('writes a PRE_PLAN_COPY item at the AC1 key from a real inspections.preplan.updated event', async () => {
    const { handler } = await import('./prePlanCopyHandler.js');

    await handler(
      sqsEvent('inspections.preplan.updated', 'PP-0044', {
        deptId: 'NICHOLS',
        occupancyId: 'OCC-0231',
        summary: 'Two-story residential, rear LPG tank',
        hazards: ['LPG_TANK_REAR'],
        utilityShutoffs: [{ utility: 'gas', location: 'rear yard' }],
      }),
    );

    const item = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: 'DEPT#NICHOLS#PREPLAN', sk: 'OCCUPANCY#OCC-0231' },
      }),
    );

    expect(item.Item).toMatchObject({
      entityType: 'PRE_PLAN_COPY',
      summary: 'Two-story residential, rear LPG tank',
      hazards: ['LPG_TANK_REAR'],
      utilityShutoffs: [{ utility: 'gas', location: 'rear yard' }],
    });
  });

  it('re-resolves and rewrites nearestHydrants against a seeded PRE_PLAN_COPY item (AC2)', async () => {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: 'DEPT#NICHOLS#PREPLAN',
          sk: 'OCCUPANCY#OCC-0400',
          entityType: 'PRE_PLAN_COPY',
          nearestHydrants: [{ hydrantId: 'HYD-0400', status: 'IN_SERVICE', flowRatingGpm: 800 }],
          snapshotUpdatedAt: Date.parse('2026-09-05T00:00:00Z'),
        },
      }),
    );

    const { handler } = await import('./hydrantCopyHandler.js');

    await handler(
      sqsEvent('inspections.hydrant.updated', 'HYD-0400', {
        deptId: 'NICHOLS',
        hydrantId: 'HYD-0400',
        status: 'OUT_OF_SERVICE',
      }),
    );

    const item = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: 'DEPT#NICHOLS#PREPLAN', sk: 'OCCUPANCY#OCC-0400' },
      }),
    );

    expect(item.Item?.nearestHydrants).toEqual([]);
  });
});
