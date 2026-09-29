import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Decision, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { GuardEvent } from '@boxalarm/authz';
import type { SQSEvent } from 'aws-lambda';

const TABLE_NAME = 'alerting-preplan-test';
const OCCUPANCY_POINT = { latitude: 41.2429, longitude: -73.2007 };
const north = (meters: number) => OCCUPANCY_POINT.latitude + meters / 111_320;

let sequence = 0;

/** The whole EventBridge event, as the rule -> SQS target (no input transformer) delivers it. */
function sqsEvent(
  eventType: string,
  payload: Record<string, unknown>,
  eventTime = '2026-09-06T00:00:00Z',
) {
  sequence += 1;
  return {
    Records: [
      {
        messageId: `msg-${sequence}`,
        body: JSON.stringify({
          version: '0',
          id: `eb-${sequence}`,
          'detail-type': eventType,
          source: 'inspections-service',
          detail: {
            eventId: `evt-${sequence}`,
            eventTime,
            eventType,
            source: 'inspections-service',
            correlationId: `corr-${sequence}`,
            schemaVersion: '1.0',
            payload,
          },
        }),
      },
    ],
  } as unknown as SQSEvent;
}

function detailEvent(dispatchId: string): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/alerting/dispatches/{dispatchId}',
    rawPath: `/api/v1/alerting/dispatches/${dispatchId}`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token-1' },
    pathParameters: { dispatchId },
    requestContext: {
      authorizer: { lambda: { sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' } },
    },
  } as unknown as GuardEvent;
}

function allowClient(): VerifiedPermissionsClient {
  return {
    send: () => Promise.resolve({ decision: Decision.ALLOW }),
  } as unknown as VerifiedPermissionsClient;
}

describe('pre-plan + hydrant copies -> dispatch detail (real DynamoDB with the alerting GSIs)', () => {
  let container: StartedLocalStackContainer;
  let client: DynamoDBDocumentClient;

  beforeAll(async () => {
    container = await new LocalstackContainer('localstack/localstack:4').start();
    const base = new DynamoDBClient({
      endpoint: container.getConnectionUri(),
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    // Mirrors infrastructure/components/data/alerting-table.ts.
    await base.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
          { AttributeName: 'gsi1pk', AttributeType: 'S' },
          { AttributeName: 'gsi1sk', AttributeType: 'S' },
          { AttributeName: 'gsi2pk', AttributeType: 'S' },
          { AttributeName: 'gsi2sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI1',
            KeySchema: [
              { AttributeName: 'gsi1pk', KeyType: 'HASH' },
              { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'GSI2',
            KeySchema: [
              { AttributeName: 'gsi2pk', KeyType: 'HASH' },
              { AttributeName: 'gsi2sk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
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
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => client };
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.doUnmock('../eligibility/dynamoClient.js');
    vi.restoreAllMocks();
  });

  async function consumePrePlan(payload: Record<string, unknown>, eventTime?: string) {
    const { handler } = await import('./prePlanCopyHandler.js');
    await handler(sqsEvent('inspections.preplan.updated', payload, eventTime));
  }

  async function consumeHydrant(payload: Record<string, unknown>, eventTime?: string) {
    const { handler } = await import('./hydrantCopyHandler.js');
    await handler(sqsEvent('inspections.hydrant.updated', payload, eventTime));
  }

  async function putDispatch(dispatchId: string, address: string) {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `DEPT#NICHOLS#DISPATCH#${dispatchId}`,
          sk: 'METADATA',
          entityType: 'DISPATCH_ALERT',
          dispatchId,
          incidentType: 'STRUCTURE_FIRE',
          address,
          crossStreets: 'Main & Elm',
          narrative: 'Smoke showing',
        },
      }),
    );
  }

  async function detail(dispatchId: string) {
    const { createHandler } = await import('../dispatches/detail/handler.js');
    const result = await createHandler({ authzClient: allowClient(), docClient: client })(
      detailEvent(dispatchId),
    );
    expect(result).toMatchObject({ statusCode: 200 });
    return JSON.parse((result as { body: string }).body) as {
      address: string;
      prePlan: {
        summary?: string;
        hazards: string[];
        utilityShutoffs: unknown[];
        nearestHydrants: Array<{ hydrantId: string; distanceMeters: number; flowClass?: string }>;
      } | null;
    };
  }

  it('a manual dispatch to "123 main st, Apt 4" shows the pre-plan filed at "123 Main Street" and its nearest hydrants', async () => {
    await consumePrePlan({
      deptId: 'NICHOLS',
      occupancyId: 'OCC-0231',
      prePlanId: 'PP-0044',
      summary: 'Multi family — 123 Main Street',
      occupancyType: 'MULTI_FAMILY',
      address: '123 Main Street',
      normalizedAddress: '123 MAIN STREET',
      ...OCCUPANCY_POINT,
      hazards: ['LPG_TANK_REAR'],
      utilityShutoffs: [{ utility: 'gas', location: 'rear yard' }],
    });
    for (const [hydrantId, meters, extra] of [
      ['HYD-400', 400, {}],
      ['HYD-90', 90, { flowRatingGpm: 1600, size: '6-inch' }],
      ['HYD-OOS', 15, { status: 'OUT_OF_SERVICE' }],
      ['HYD-210', 210, {}],
    ] as const) {
      await consumeHydrant({
        deptId: 'NICHOLS',
        hydrantId,
        latitude: north(meters),
        longitude: OCCUPANCY_POINT.longitude,
        status: 'IN_SERVICE',
        ...extra,
      });
    }
    await putDispatch('NICHOLS-MANUAL-1', '123 main st, Apt 4');

    const body = await detail('NICHOLS-MANUAL-1');

    expect(body.address).toBe('123 main st, Apt 4');
    expect(body.prePlan).toMatchObject({
      summary: 'Multi family — 123 Main Street',
      hazards: ['LPG_TANK_REAR'],
      utilityShutoffs: [{ utility: 'gas', location: 'rear yard' }],
    });
    expect(body.prePlan?.nearestHydrants.map((h) => h.hydrantId)).toEqual([
      'HYD-90',
      'HYD-210',
      'HYD-400',
    ]);
    expect(body.prePlan?.nearestHydrants[0]).toMatchObject({ distanceMeters: 90, flowClass: 'AA' });
  });

  it('a later out-of-service event drops that hydrant from the next dispatch view', async () => {
    await consumeHydrant(
      { deptId: 'NICHOLS', hydrantId: 'HYD-90', status: 'OUT_OF_SERVICE' },
      '2026-09-07T00:00:00Z',
    );
    await putDispatch('NICHOLS-MANUAL-2', '123 Main St');

    const body = await detail('NICHOLS-MANUAL-2');

    expect(body.prePlan?.nearestHydrants.map((h) => h.hydrantId)).toEqual(['HYD-210', 'HYD-400']);
    const copy = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: 'DEPT#NICHOLS#HYDRANT', sk: 'HYDRANT#HYD-90' },
      }),
    );
    // A status-only event keeps the known flow rating.
    expect(copy.Item).toMatchObject({ status: 'OUT_OF_SERVICE', flowRatingGpm: 1600 });
  });

  it('discards an older pre-plan event that arrives after a newer one (staleness guard)', async () => {
    await consumePrePlan(
      {
        deptId: 'NICHOLS',
        occupancyId: 'OCC-0231',
        summary: 'stale',
        address: '123 Main Street',
        hazards: ['OLD'],
        utilityShutoffs: [],
      },
      '2026-09-01T00:00:00Z',
    );

    const copy = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: 'DEPT#NICHOLS#PREPLAN', sk: 'OCCUPANCY#OCC-0231' },
      }),
    );
    expect(copy.Item).toMatchObject({ entityType: 'PRE_PLAN_COPY', hazards: ['LPG_TANK_REAR'] });
  });

  it('shows no pre-plan for an address with none on file', async () => {
    await putDispatch('NICHOLS-MANUAL-3', '999 Nowhere Ln');
    expect((await detail('NICHOLS-MANUAL-3')).prePlan).toBeNull();
  });
});
