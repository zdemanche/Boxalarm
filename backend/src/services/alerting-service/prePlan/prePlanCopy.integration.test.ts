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
    process.env.ALERTING_HOME_LOCALITY = JSON.stringify({
      towns: ['Trumbull', 'Nichols', 'Long Hill', 'Trumbull Center'],
      zips: ['06611'],
      state: 'CT',
    });
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

  // Dispatches the dispatcher placed in a home town (R3-A: no locality, no verified match).
  async function putDispatch(
    dispatchId: string,
    address: string,
    extra: Record<string, unknown> = {},
  ) {
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
          ...extra,
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
        matchType?: string;
        matchedAddress?: string;
        unit?: string | null;
        distanceMeters?: number;
        summary?: string;
        hazards: string[];
        utilityShutoffs: unknown[];
        candidates?: Array<{ occupancyId: string; unit: string | null }>;
      } | null;
      nearestHydrants?: Array<{
        hydrantId: string;
        status?: string;
        distanceMeters: number;
        flowClass?: string;
      }>;
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
    await putDispatch('NICHOLS-MANUAL-1', '123 main st, Apt 4', {
      locality: { town: 'Trumbull', choice: 'HOME' },
    });

    const body = await detail('NICHOLS-MANUAL-1');

    expect(body.address).toBe('123 main st, Apt 4');
    expect(body.prePlan).toMatchObject({
      // Building-level plan for a unit dispatch: flagged, naming the unit (R3-C).
      matchType: 'ADDRESS_BUILDING',
      dispatchUnit: 'APT 4',
      summary:
        'VERIFY ADDRESS: building-level pre-plan for 123 Main Street; no plan for APT 4. Multi family — 123 Main Street',
      occupancySummary: 'Multi family — 123 Main Street',
      hazards: ['LPG_TANK_REAR'],
      utilityShutoffs: [{ utility: 'gas', location: 'rear yard' }],
    });
    // HYD-OOS (15 m) is listed first and flagged — not hidden, not counted.
    expect(body.nearestHydrants?.map((h) => [h.hydrantId, h.status])).toEqual([
      ['HYD-OOS', 'OUT_OF_SERVICE'],
      ['HYD-90', 'IN_SERVICE'],
      ['HYD-210', 'IN_SERVICE'],
      ['HYD-400', 'IN_SERVICE'],
    ]);
    expect(body.nearestHydrants?.[1]).toMatchObject({ distanceMeters: 90, flowClass: 'AA' });
  });

  it('a later out-of-service event flags that hydrant on the next dispatch view', async () => {
    await consumeHydrant(
      { deptId: 'NICHOLS', hydrantId: 'HYD-90', status: 'OUT_OF_SERVICE' },
      '2026-09-07T00:00:00Z',
    );
    await putDispatch('NICHOLS-MANUAL-2', '123 Main St', {
      locality: { town: 'Trumbull', choice: 'HOME' },
    });

    const body = await detail('NICHOLS-MANUAL-2');

    expect(body.nearestHydrants?.map((h) => [h.hydrantId, h.status])).toEqual([
      ['HYD-OOS', 'OUT_OF_SERVICE'],
      ['HYD-90', 'OUT_OF_SERVICE'],
      ['HYD-210', 'IN_SERVICE'],
      ['HYD-400', 'IN_SERVICE'],
    ]);
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

  describe('matching through the real keys (review minor 12)', () => {
    const plan = (occupancyId: string, address: string, extra: Record<string, unknown> = {}) =>
      consumePrePlan({
        deptId: 'NICHOLS',
        occupancyId,
        summary: `Plan for ${address}`,
        address,
        hazards: [`HAZARD-${occupancyId}`],
        utilityShutoffs: [],
        ...extra,
      });
    let n = 0;
    const lookup = async (address: string, extra: Record<string, unknown> = {}) => {
      n += 1;
      await putDispatch(`NICHOLS-MATCH-${n}`, address, extra);
      return detail(`NICHOLS-MATCH-${n}`);
    };

    it('false positives stay apart: 12 vs 12A, designator-named streets, two towns', async () => {
      await plan('OCC-12', '12 Oak Ln');
      await plan('OCC-LOT', '100 Lot Rd');
      await plan('OCC-TRUMBULL', '5 Main St, Trumbull, CT 06611');

      expect((await lookup('12A Oak Ln')).prePlan).toBeNull();
      expect(
        (await lookup('12 Oak Lane', { locality: { town: 'Trumbull', choice: 'HOME' } })).prePlan,
      ).toMatchObject({
        matchType: 'ADDRESS',
        hazards: ['HAZARD-OCC-12'],
      });
      expect((await lookup('100 Space Ln')).prePlan).toBeNull();
      expect(
        (await lookup('100 Lot Road', { locality: { town: 'Trumbull', choice: 'HOME' } })).prePlan,
      ).toMatchObject({ matchType: 'ADDRESS' });
      expect((await lookup('5 Main St, Bridgeport, CT')).prePlan).toBeNull();
      // Round-2 A: a town-less (home) pre-plan never matches a dispatch in another town.
      expect((await lookup('12 Oak Ln, Bridgeport, CT')).prePlan).toBeNull();
      // Round-2 B: a comma-less known town is the town; a later suffix is part of the street.
      expect((await lookup('5 MAIN ST TRUMBULL CT 06611')).prePlan).toMatchObject({
        matchType: 'ADDRESS',
        hazards: ['HAZARD-OCC-TRUMBULL'],
      });
      await plan('OCC-MOUNT', '7 Mount St');
      expect((await lookup('7 Mount St Joseph Rd')).prePlan).toBeNull();
      expect((await lookup('5 Main Street, Trumbull, CT 06611')).prePlan).toMatchObject({
        matchType: 'ADDRESS',
        hazards: ['HAZARD-OCC-TRUMBULL'],
      });
    });

    it('unit tie-break: exact unit, else every unit plan as CANDIDATES — never the newest', async () => {
      await plan('OCC-A', '40 Oak Ave Unit A');
      await plan('OCC-B', '40 Oak Ave Unit B');

      expect(
        (await lookup('40 Oak Avenue Unit B', { locality: { town: 'Trumbull', choice: 'HOME' } }))
          .prePlan,
      ).toMatchObject({
        matchType: 'ADDRESS',
        unit: 'B',
        hazards: ['HAZARD-OCC-B'],
      });
      for (const address of ['40 Oak Ave', '40 Oak Ave Unit C']) {
        const { prePlan } = await lookup(address);
        expect(prePlan?.matchType).toBe('CANDIDATES');
        expect(prePlan?.hazards).toEqual([]);
        expect(prePlan?.candidates?.map((c) => [c.occupancyId, c.unit])).toEqual([
          ['OCC-A', 'A'],
          ['OCC-B', 'B'],
        ]);
      }
    });

    it('coordinate fallback only without a usable street address, flagged NEARBY with distance', async () => {
      const birch = { latitude: 41.31, longitude: -73.15 };
      await plan('OCC-BIRCH', '9 Birch Rd', birch);
      const thirtyMetresNorth = {
        latitude: birch.latitude + 30 / 111_320,
        longitude: birch.longitude,
      };

      expect((await lookup('I-95 NB near exit 27', thirtyMetresNorth)).prePlan).toMatchObject({
        matchType: 'NEARBY',
        matchedAddress: '9 Birch Rd',
        distanceMeters: 30,
      });
      // A usable address that matches nothing never borrows the neighbour's plan.
      expect((await lookup('11 Birch Rd', thirtyMetresNorth)).prePlan).toBeNull();
    });

    it("cross-department isolation: another department's pre-plan and hydrants never surface", async () => {
      const elm = { latitude: 41.35, longitude: -73.25 };
      await consumePrePlan({
        deptId: 'OTHERFD',
        occupancyId: 'OCC-OTHER',
        summary: 'Other department',
        address: '77 Elm St',
        hazards: ['NOT-OURS'],
        utilityShutoffs: [],
        ...elm,
      });
      await consumeHydrant({
        deptId: 'OTHERFD',
        hydrantId: 'HYD-OTHER',
        status: 'IN_SERVICE',
        ...elm,
      });

      const body = await lookup('77 Elm St', elm);

      expect(body.prePlan).toBeNull();
      expect(body.nearestHydrants ?? []).toEqual([]);
    });

    it('ring widening: a rural call still finds a hydrant ~2 km away', async () => {
      const rural = { latitude: 41.4, longitude: -73.4 };
      await consumeHydrant({
        deptId: 'NICHOLS',
        hydrantId: 'HYD-RURAL',
        status: 'IN_SERVICE',
        latitude: rural.latitude + 2000 / 111_320,
        longitude: rural.longitude,
      });

      const body = await lookup('Route 111 wooded area', rural);

      expect(body.prePlan).toBeNull();
      expect(body.nearestHydrants?.map((h) => h.hydrantId)).toEqual(['HYD-RURAL']);
      // Beyond the geohash6 ring (~0.6 km): only the widened geohash5 ring reaches it.
      expect(body.nearestHydrants?.[0]?.distanceMeters).toBeGreaterThan(1990);
      expect(body.nearestHydrants?.[0]?.distanceMeters).toBeLessThan(2010);
    });
  });

  describe('archive tombstones through the real keys (review N14)', () => {
    let n = 0;
    const view = async (address: string, extra: Record<string, unknown> = {}) => {
      n += 1;
      await putDispatch(`NICHOLS-ARCHIVE-${n}`, address, extra);
      return detail(`NICHOLS-ARCHIVE-${n}`);
    };

    it('an archived occupancy stops matching, stays archived, and a racing later save cannot revive it', async () => {
      const cedar = { latitude: 41.33, longitude: -73.3 };
      await consumePrePlan(
        {
          deptId: 'NICHOLS',
          occupancyId: 'OCC-CEDAR',
          summary: 'Cedar',
          address: '55 Cedar Ln',
          hazards: ['TRUSS_ROOF'],
          utilityShutoffs: [],
          ...cedar,
        },
        '2026-09-10T00:00:00Z',
      );
      expect(
        (await view('55 Cedar Ln', { locality: { town: 'Trumbull', choice: 'HOME' } })).prePlan,
      ).toMatchObject({ matchType: 'ADDRESS' });

      // N1: the archive's eventTime is OLDER than the stored save — it must still apply.
      await consumePrePlan(
        { deptId: 'NICHOLS', occupancyId: 'OCC-CEDAR', archived: true },
        '2026-09-09T00:00:00Z',
      );
      expect((await view('55 Cedar Ln')).prePlan).toBeNull();
      expect((await view('I-95 NB exit 27', cedar)).prePlan).toBeNull();

      // A later ordinary event (a replay, a racing save) never overwrites the tombstone.
      await consumePrePlan(
        {
          deptId: 'NICHOLS',
          occupancyId: 'OCC-CEDAR',
          summary: 'Cedar',
          address: '55 Cedar Ln',
          hazards: ['TRUSS_ROOF'],
          utilityShutoffs: [],
          ...cedar,
        },
        '2026-09-20T00:00:00Z',
      );
      expect((await view('55 Cedar Ln')).prePlan).toBeNull();
      const copy = await client.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: 'DEPT#NICHOLS#PREPLAN', sk: 'OCCUPANCY#OCC-CEDAR' },
        }),
      );
      expect(copy.Item).toMatchObject({ archivedAt: Date.parse('2026-09-09T00:00:00Z') });
      expect(copy.Item).not.toHaveProperty('gsi1pk');
      expect(copy.Item).not.toHaveProperty('gsi2pk');
    });

    it('an archived hydrant drops off every nearest-hydrant list for good', async () => {
      const spot = { latitude: 41.37, longitude: -73.33 };
      await consumeHydrant(
        { deptId: 'NICHOLS', hydrantId: 'HYD-GONE', status: 'IN_SERVICE', ...spot },
        '2026-09-10T00:00:00Z',
      );
      expect(
        (await view('I-95 NB exit 28', spot)).nearestHydrants?.map((h) => h.hydrantId),
      ).toEqual(['HYD-GONE']);

      await consumeHydrant(
        { deptId: 'NICHOLS', hydrantId: 'HYD-GONE', archived: true },
        '2026-09-11T00:00:00Z',
      );
      await consumeHydrant(
        { deptId: 'NICHOLS', hydrantId: 'HYD-GONE', status: 'IN_SERVICE', ...spot },
        '2026-09-12T00:00:00Z',
      );

      expect((await view('I-95 NB exit 28', spot)).nearestHydrants ?? []).toEqual([]);
    });
  });
});
