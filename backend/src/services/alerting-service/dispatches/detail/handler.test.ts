import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent } from '@boxalarm/authz';

const PRINCIPAL = { sub: 'member-0012', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' };

function buildEvent(
  dispatchId: string | undefined,
  headers: Record<string, string> | undefined = { authorization: 'Bearer token-1' },
  principal: typeof PRINCIPAL | undefined = PRINCIPAL,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/alerting/dispatches/{dispatchId}',
    rawPath: `/api/v1/alerting/dispatches/${dispatchId ?? ''}`,
    rawQueryString: '',
    headers,
    pathParameters: dispatchId ? { dispatchId } : undefined,
    requestContext: { authorizer: { lambda: principal } },
  } as unknown as GuardEvent;
}

function fakeAuthzClient(decision: 'ALLOW' | 'DENY'): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

const DISPATCH_ITEM = {
  dispatchId: 'NICHOLS-4471-1798000000',
  incidentType: 'STRUCTURE_FIRE',
  address: '123 Main St',
  crossStreets: 'Main & Elm',
  narrative: 'Smoke showing, 2nd floor',
  // The dispatcher's locality choice (R3-A): without it no pre-plan is ever verified.
  locality: { town: 'Trumbull', choice: 'HOME' },
};

interface QueryInput {
  readonly IndexName?: string;
  readonly ExpressionAttributeValues: Record<string, unknown>;
}

/** GetItems answered by sk (the dispatch METADATA, no mutual aid); Queries by `queries`. */
function routedClient(options: {
  dispatch?: Record<string, unknown>;
  queries: (input: QueryInput) => Promise<unknown>;
  onGet?: (key: { pk: string; sk: string }) => void;
}): DynamoDBDocumentClient {
  return {
    send: vi.fn((command: { input: { Key?: { pk: string; sk: string } } & QueryInput }) => {
      const key = command.input.Key;
      if (!key) return options.queries(command.input);
      options.onGet?.(key);
      return Promise.resolve({
        Item: key.sk === 'METADATA' ? (options.dispatch ?? DISPATCH_ITEM) : undefined,
      });
    }),
  } as unknown as DynamoDBDocumentClient;
}

describe('alert-detail handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'store-1';
    process.env.ALERTING_HOME_LOCALITY = JSON.stringify({
      deptId: 'NICHOLS',
      towns: ['Trumbull', 'Nichols', 'Long Hill', 'Trumbull Center'],
      zips: ['06611'],
      state: 'CT',
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 200 with incident type, address, cross streets, map link, and narrative (AC1, entrypoint test)', async () => {
    const { createHandler } = await import('./handler.js');
    const docClient = {
      send: vi.fn().mockResolvedValue({ Item: DISPATCH_ITEM }),
    } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).toMatchObject({
      dispatchId: 'NICHOLS-4471-1798000000',
      incidentType: 'STRUCTURE_FIRE',
      address: '123 Main St',
      crossStreets: 'Main & Elm',
      narrative: 'Smoke showing, 2nd floor',
      mapLink: 'https://www.google.com/maps/search/?api=1&query=123%20Main%20St',
      eligibleMemberCount: null,
      fanOutStartedAt: null,
      toneLadder: { status: 'ACTIVE', currentToneSequence: 1, nextToneAt: null },
      prePlan: null,
    });
  });

  it('passes eligibleMemberCount/fanOutStartedAt through when E1-S2 has populated them, without blocking on their absence otherwise', async () => {
    const { createHandler } = await import('./handler.js');
    const docClient = {
      send: vi.fn().mockResolvedValue({
        Item: { ...DISPATCH_ITEM, eligibleMemberCount: 34, fanOutStartedAt: 1798000002 },
      }),
    } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.eligibleMemberCount).toBe(34);
    expect(body.fanOutStartedAt).toBe(1798000002);
  });

  it('AC2: renders full core content and says the pre-plan is unavailable (never "none") when the lookup throws — isolation from the alert-path failure domain', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createHandler } = await import('./handler.js');
    const docClient = routedClient({
      queries: () => Promise.reject(new Error('pre-plan index unavailable')),
    });
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect('prePlan' in body).toBe(false);
    expect(body.prePlanUnavailable).toBe(true);
    expect(body.address).toBe('123 Main St');
    expect(body.narrative).toBe('Smoke showing, 2nd floor');
    const logged = errorSpy.mock.calls.map((call) => call[0] as string).join('\n');
    expect(logged).toContain('dispatches.detail.preplan_read_failed');
    expect(logged).toContain('pre-plan index unavailable');
    errorSpy.mockRestore();
  });

  it('a RAW (VERIFY) CAD dispatch: verifyRequired is returned and there is no map link', async () => {
    const { createHandler } = await import('./handler.js');
    const docClient = routedClient({
      dispatch: {
        ...DISPATCH_ITEM,
        address: 'SEE DISPATCH TEXT',
        verifyRequired: true,
        narrative: 'SMOKE AT THE OLD MILL',
      },
      queries: () => Promise.resolve({ Items: [] }),
    });
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });
    const body = JSON.parse(
      ((await handler(buildEvent('NICHOLS-4471-1798000000'))) as { body: string }).body,
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ verifyRequired: true, mapLink: null });
  });

  it('returns the CAD update history oldest first', async () => {
    const { createHandler } = await import('./handler.js');
    const update = (updateId: string, receivedAt: number) => ({
      entityType: 'DISPATCH_UPDATE',
      updateId,
      receivedAt,
      summary: `Units: ${updateId}`,
      changes: [{ field: 'unitsRequested', from: 'E1', to: updateId }],
    });
    const docClient = routedClient({
      queries: (input) =>
        Promise.resolve({
          Items:
            input.ExpressionAttributeValues[':update'] === 'UPDATE#'
              ? [update('u2', 200), update('u1', 100)]
              : [],
        }),
    });
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });
    const body = JSON.parse(
      ((await handler(buildEvent('NICHOLS-4471-1798000000'))) as { body: string }).body,
    ) as { updates: { updateId: string }[] };
    expect(body.updates.map((u) => u.updateId)).toEqual(['u1', 'u2']);
  });

  it('flags the CAD update history unavailable when its read fails, and still answers', async () => {
    const { createHandler } = await import('./handler.js');
    const failing = routedClient({
      queries: (input) =>
        input.ExpressionAttributeValues[':update'] === 'UPDATE#'
          ? Promise.reject(new Error('throttled'))
          : Promise.resolve({ Items: [] }),
    });
    const handler2 = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient: failing });
    const result = (await handler2(buildEvent('NICHOLS-4471-1798000000'))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ updatesUnavailable: true });
  });

  describe('pre-plan + hydrant context (dispatch address -> PRE_PLAN_COPY -> HYDRANT_COPY)', () => {
    const OCCUPANCY_POINT = { latitude: 41.2429, longitude: -73.2007 };
    const PRE_PLAN_COPY = {
      entityType: 'PRE_PLAN_COPY',
      occupancyId: 'OCC-0231',
      summary: 'Multi family — 123 Main Street',
      address: '123 Main Street',
      hazards: ['LPG_TANK_REAR'],
      utilityShutoffs: [{ utility: 'GAS', location: 'rear of building' }],
      ...OCCUPANCY_POINT,
      snapshotUpdatedAt: 1,
    };
    const hydrantAt = (hydrantId: string, northMeters: number, extra = {}) => ({
      entityType: 'HYDRANT_COPY',
      hydrantId,
      status: 'IN_SERVICE',
      latitude: OCCUPANCY_POINT.latitude + northMeters / 111_320,
      longitude: OCCUPANCY_POINT.longitude,
      ...extra,
    });

    it('matches the pre-plan by normalized address and lists the nearest hydrants to its occupancy', async () => {
      const { createHandler } = await import('./handler.js');
      const docClient = routedClient({
        queries: (input) => {
          if (input.IndexName === 'GSI1') {
            // "123 Main St" on the dispatch vs "123 Main Street" on the occupancy.
            expect(input.ExpressionAttributeValues[':gsi1pk']).toBe(
              'DEPT#NICHOLS#PREPLAN_ADDR#123 MAIN ST',
            );
            return Promise.resolve({ Items: [PRE_PLAN_COPY] });
          }
          return Promise.resolve({
            Items: `${input.ExpressionAttributeValues[':gsi2pk'] as string}`.includes('HYDRANT_GEO')
              ? [
                  hydrantAt('H-300', 300),
                  hydrantAt('H-80', 80, { size: '6-inch', flowRatingGpm: 1100 }),
                  hydrantAt('H-OOS', 20, { status: 'OUT_OF_SERVICE' }),
                  hydrantAt('H-150', 150),
                ]
              : [],
          });
        },
      });
      const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

      const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

      expect(result).toMatchObject({ statusCode: 200 });
      const body = JSON.parse((result as { body: string }).body) as {
        prePlan: { nearestHydrants: Array<Record<string, unknown>> } & Record<string, unknown>;
        nearestHydrants: Array<Record<string, unknown>>;
      };
      expect(body.prePlan).toMatchObject({
        matchType: 'ADDRESS',
        matchedAddress: '123 Main Street',
        unit: null,
        summary: 'Multi family — 123 Main Street',
        hazards: ['LPG_TANK_REAR'],
        utilityShutoffs: [{ utility: 'GAS', location: 'rear of building' }],
      });
      expect(body.nearestHydrants.map((h) => h.hydrantId)).toEqual([
        'H-OOS',
        'H-80',
        'H-150',
        'H-300',
      ]);
      expect(body.nearestHydrants[0]).toMatchObject({
        hydrantId: 'H-OOS',
        status: 'OUT_OF_SERVICE',
      });
      // The legacy per-plan list (rendered by older clients with no status label) never
      // carries an out-of-service hydrant.
      expect(body.prePlan.nearestHydrants.map((h) => h.hydrantId)).toEqual([
        'H-80',
        'H-150',
        'H-300',
      ]);
      expect(body.nearestHydrants[1]).toMatchObject({
        hydrantId: 'H-80',
        status: 'IN_SERVICE',
        size: '6-inch',
        flowRatingGpm: 1100,
        flowClass: 'A',
        distanceMeters: 80,
      });
    });

    it('is null when no pre-plan is on file for the address and the dispatch has no coordinates', async () => {
      const { createHandler } = await import('./handler.js');
      const queries = vi.fn(() => Promise.resolve({ Items: [] }));
      const docClient = routedClient({ queries });
      const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

      const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

      const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
      expect(body.prePlan).toBeNull();
      // Only the address lookup ran (plus the CAD update history on the dispatch's own
      // partition): no coordinates, so no geo match or hydrant search.
      const indexQueries = queries.mock.calls.filter(
        (call) => (call as unknown as [{ IndexName?: string }])[0].IndexName !== undefined,
      );
      expect(indexQueries).toHaveLength(1);
    });

    it('flags a pre-plan within 50 m as NEARBY with its distance when the dispatch has coordinates but no usable street address (CAD)', async () => {
      const { createHandler } = await import('./handler.js');
      const docClient = routedClient({
        dispatch: { ...DISPATCH_ITEM, address: 'I-95 NB near exit 27', ...OCCUPANCY_POINT },
        queries: (input) => {
          const pk = input.ExpressionAttributeValues[':gsi2pk'];
          if (typeof pk === 'string' && pk.includes('PREPLAN_GEO')) {
            return Promise.resolve({ Items: [PRE_PLAN_COPY] });
          }
          return Promise.resolve({ Items: [] });
        },
      });
      const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

      const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

      const body = JSON.parse((result as { body: string }).body) as {
        prePlan: Record<string, unknown> | null;
      };
      expect(body.prePlan).toMatchObject({
        matchType: 'NEARBY',
        matchedAddress: '123 Main Street',
        distanceMeters: 0,
        occupancySummary: 'Multi family — 123 Main Street',
        // N2: an older client renders only `summary`, so it leads with the provenance.
        summary:
          'VERIFY ADDRESS: nearby pre-plan for 123 Main Street, 0 m away. Multi family — 123 Main Street',
      });
    });

    it('N13: hydrants for geo CANDIDATES are measured from the dispatch point, not a candidate', async () => {
      const { createHandler } = await import('./handler.js');
      const north = (m: number) => ({
        latitude: OCCUPANCY_POINT.latitude + m / 111_320,
        longitude: OCCUPANCY_POINT.longitude,
      });
      const docClient = routedClient({
        dispatch: { ...DISPATCH_ITEM, address: 'I-95 NB near exit 27', ...OCCUPANCY_POINT },
        queries: (input) => {
          const pk = `${input.ExpressionAttributeValues[':gsi2pk'] as string}`;
          if (pk.includes('PREPLAN_GEO')) {
            return Promise.resolve({
              Items: [
                { ...PRE_PLAN_COPY, occupancyId: 'OCC-20', ...north(20) },
                { ...PRE_PLAN_COPY, occupancyId: 'OCC-45', ...north(45) },
              ],
            });
          }
          if (pk.includes('HYDRANT_GEO')) {
            return Promise.resolve({ Items: [hydrantAt('H-AT-DISPATCH', 0)] });
          }
          return Promise.resolve({ Items: [] });
        },
      });
      const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

      const body = JSON.parse(
        ((await handler(buildEvent('NICHOLS-4471-1798000000'))) as { body: string }).body,
      ) as { prePlan: { matchType: string }; nearestHydrants: Array<{ distanceMeters: number }> };

      expect(body.prePlan.matchType).toBe('CANDIDATES');
      expect(body.nearestHydrants[0]?.distanceMeters).toBe(0);
    });

    it('never falls back to a nearby pre-plan when the dispatch has a usable street address that matched nothing', async () => {
      const { createHandler } = await import('./handler.js');
      const queries = vi.fn((input: QueryInput) => {
        const pk = input.ExpressionAttributeValues[':gsi2pk'];
        return Promise.resolve({
          Items: typeof pk === 'string' && pk.includes('PREPLAN_GEO') ? [PRE_PLAN_COPY] : [],
        });
      });
      const docClient = routedClient({
        dispatch: { ...DISPATCH_ITEM, address: '14 Main St', ...OCCUPANCY_POINT },
        queries,
      });
      const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

      const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

      const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
      expect(body.prePlan).toBeNull();
      // No nearby-pre-plan query (only the address lookup and the dispatch-point hydrant search).
      expect(
        queries.mock.calls.some((call) =>
          `${call[0].ExpressionAttributeValues[':gsi2pk'] as string}`.includes('PREPLAN_GEO'),
        ),
      ).toBe(false);
    });

    it('returns a lone plan for another unit flagged UNIT_MISMATCH, with its unit', async () => {
      const { createHandler } = await import('./handler.js');
      const docClient = routedClient({
        dispatch: { ...DISPATCH_ITEM, address: '123 Main St Apt 3' },
        queries: (input) =>
          Promise.resolve({
            Items:
              input.IndexName === 'GSI1'
                ? [{ ...PRE_PLAN_COPY, address: '123 Main Street Apt 2', addressUnit: '2' }]
                : [],
          }),
      });
      const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

      const body = JSON.parse(
        ((await handler(buildEvent('NICHOLS-4471-1798000000'))) as { body: string }).body,
      ) as Record<string, unknown>;

      expect(body.prePlan).toMatchObject({
        matchType: 'UNIT_MISMATCH',
        matchedAddress: '123 Main Street Apt 2',
        unit: '2',
        hazards: ['LPG_TANK_REAR'],
      });
    });

    it('lists every unit plan as CANDIDATES (with each hazard list) and no top-level hazards', async () => {
      const { createHandler } = await import('./handler.js');
      const docClient = routedClient({
        queries: (input) =>
          Promise.resolve({
            Items:
              input.IndexName === 'GSI1'
                ? [
                    {
                      ...PRE_PLAN_COPY,
                      occupancyId: 'OCC-B',
                      address: '123 Main St Unit B',
                      addressUnit: 'B',
                      summary: 'Pool chemicals',
                      hazards: ['CHLORINE'],
                    },
                    {
                      ...PRE_PLAN_COPY,
                      occupancyId: 'OCC-A',
                      address: '123 Main St Unit A',
                      addressUnit: 'A',
                      summary: 'Bakery',
                      hazards: [],
                    },
                  ]
                : [],
          }),
      });
      const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

      const body = JSON.parse(
        ((await handler(buildEvent('NICHOLS-4471-1798000000'))) as { body: string }).body,
      ) as { prePlan: Record<string, unknown> };

      expect(body.prePlan).toMatchObject({
        matchType: 'CANDIDATES',
        summary:
          'VERIFY ADDRESS: 2 pre-plans match this address (A, B). Update the app to see them.',
        hazards: [],
        utilityShutoffs: [],
        candidates: [
          { occupancyId: 'OCC-A', unit: 'A', summary: 'Bakery', hazards: [] },
          { occupancyId: 'OCC-B', unit: 'B', summary: 'Pool chemicals', hazards: ['CHLORINE'] },
        ],
      });
    });

    it('keeps the matched pre-plan and degrades only the hydrant list when the hydrant read fails', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { createHandler } = await import('./handler.js');
      const docClient = routedClient({
        queries: (input) =>
          input.IndexName === 'GSI1'
            ? Promise.resolve({ Items: [PRE_PLAN_COPY] })
            : Promise.reject(new Error('hydrant index unavailable')),
      });
      const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

      const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

      expect(result).toMatchObject({ statusCode: 200 });
      const body = JSON.parse((result as { body: string }).body) as {
        prePlan: { hazards: string[]; nearestHydrants: unknown[] };
      } & Record<string, unknown>;
      expect(body.prePlan.hazards).toEqual(['LPG_TANK_REAR']);
      expect(body.prePlan.nearestHydrants).toEqual([]);
      expect('nearestHydrants' in body).toBe(false);
      expect(body.nearestHydrantsUnavailable).toBe(true);
      const logged = errorSpy.mock.calls.map((call) => call[0] as string).join('\n');
      expect(logged).toContain('dispatches.detail.hydrant_read_failed');
      errorSpy.mockRestore();
    });

    it('lists the nearest hydrants to the dispatch coordinates even when no pre-plan matched (minor 5)', async () => {
      const { createHandler } = await import('./handler.js');
      const docClient = routedClient({
        dispatch: { ...DISPATCH_ITEM, address: '14 Main St', ...OCCUPANCY_POINT },
        queries: (input) => {
          const pk = input.ExpressionAttributeValues[':gsi2pk'];
          return Promise.resolve({
            Items:
              typeof pk === 'string' && pk.includes('HYDRANT_GEO') ? [hydrantAt('H-40', 40)] : [],
          });
        },
      });
      const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

      const body = JSON.parse(
        ((await handler(buildEvent('NICHOLS-4471-1798000000'))) as { body: string }).body,
      ) as { prePlan: unknown; nearestHydrants: Array<Record<string, unknown>> };

      expect(body.prePlan).toBeNull();
      expect(body.nearestHydrants).toEqual([
        expect.objectContaining({ hydrantId: 'H-40', distanceMeters: 40 }),
      ]);
    });

    it('omits nearestHydrants when there is no reference point at all (no match, no coordinates)', async () => {
      const { createHandler } = await import('./handler.js');
      const docClient = routedClient({ queries: () => Promise.resolve({ Items: [] }) });
      const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

      const body = JSON.parse(
        ((await handler(buildEvent('NICHOLS-4471-1798000000'))) as { body: string }).body,
      ) as Record<string, unknown>;

      expect(body.prePlan).toBeNull();
      expect('nearestHydrants' in body).toBe(false);
    });

    it('never treats a prePlanRef (pre-plan id) as an occupancy id', async () => {
      const { createHandler } = await import('./handler.js');
      const gets: string[] = [];
      const docClient = routedClient({
        dispatch: { ...DISPATCH_ITEM, prePlanRefs: ['PP-0044'] },
        onGet: (key) => gets.push(`${key.pk}|${key.sk}`),
        queries: () => Promise.resolve({ Items: [] }),
      });
      const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

      await handler(buildEvent('NICHOLS-4471-1798000000'));

      expect(gets.some((key) => key.includes('PREPLAN') || key.includes('PP-0044'))).toBe(false);
    });
  });

  describe('mutualAid (officer ladder controls, F1.13)', () => {
    function bySk(items: Record<string, unknown>) {
      return {
        send: vi.fn((command: { input: { Key?: { sk: string } } }) => {
          // Pre-plan enrichment Queries (no Key) find nothing here.
          if (!command.input.Key) return Promise.resolve({ Items: [] });
          const item = items[command.input.Key.sk];
          return item instanceof Error ? Promise.reject(item) : Promise.resolve({ Item: item });
        }),
      } as unknown as DynamoDBDocumentClient;
    }

    it('is null when mutual aid has not been requested', async () => {
      const { createHandler } = await import('./handler.js');
      const handler = createHandler({
        authzClient: fakeAuthzClient('ALLOW'),
        docClient: bySk({ METADATA: DISPATCH_ITEM }),
      });

      const body = JSON.parse(
        ((await handler(buildEvent('NICHOLS-4471-1798000000'))) as { body: string }).body,
      ) as Record<string, unknown>;

      expect(body.mutualAid).toBeNull();
    });

    it('carries the requested/acknowledged state of the MUTUAL_AID_EVENT singleton', async () => {
      const { createHandler } = await import('./handler.js');
      const handler = createHandler({
        authzClient: fakeAuthzClient('ALLOW'),
        docClient: bySk({
          METADATA: DISPATCH_ITEM,
          'MUTUALAID#SINGLETON': {
            entityType: 'MUTUAL_AID_EVENT',
            reason: 'TONE_3_PREDICATE_UNMET',
            triggeredAt: 1798000360,
            acknowledgedBy: 'officer-7',
            acknowledgedAt: 1798000400,
            notes: 'Called Trumbull Center',
            adapterUsed: 'OFFICER_MANUAL_PROMPT',
          },
        }),
      });

      const body = JSON.parse(
        ((await handler(buildEvent('NICHOLS-4471-1798000000'))) as { body: string }).body,
      ) as Record<string, unknown>;

      expect(body.mutualAid).toEqual({
        triggeredAt: 1798000360,
        reason: 'TONE_3_PREDICATE_UNMET',
        triggeredBy: null,
        acknowledgedBy: 'officer-7',
        acknowledgedAt: 1798000400,
        notes: 'Called Trumbull Center',
      });
    });

    it('omits mutualAid (unknown, not "not requested") and still serves the alert when the read fails', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { createHandler } = await import('./handler.js');
      const handler = createHandler({
        authzClient: fakeAuthzClient('ALLOW'),
        docClient: bySk({
          METADATA: DISPATCH_ITEM,
          'MUTUALAID#SINGLETON': new Error('throttled'),
        }),
      });

      const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

      expect(result).toMatchObject({ statusCode: 200 });
      const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
      expect(body.address).toBe('123 Main St');
      expect('mutualAid' in body).toBe(false);
      errorSpy.mockRestore();
    });
  });

  it('returns 400 when dispatchId path parameter is absent', async () => {
    const { createHandler } = await import('./handler.js');
    const sendSpy = vi.fn();
    const docClient = { send: sendSpy } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent(undefined));

    expect(result).toMatchObject({ statusCode: 400 });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('returns 400 (not 503) when dispatchId contains the pk delimiter "#"', async () => {
    const { createHandler } = await import('./handler.js');
    const sendSpy = vi.fn();
    const docClient = { send: sendSpy } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('a#b'));

    expect(result).toMatchObject({ statusCode: 400 });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('prefers the stored mapLink over a recomputed address-based link (AC1)', async () => {
    const { createHandler } = await import('./handler.js');
    const docClient = {
      send: vi
        .fn()
        .mockResolvedValue({ Item: { ...DISPATCH_ITEM, mapLink: 'https://maps.example/stored' } }),
    } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.mapLink).toBe('https://maps.example/stored');
  });

  it('builds a coordinate-based mapLink when latitude/longitude are stored but mapLink is not', async () => {
    const { createHandler } = await import('./handler.js');
    const docClient = {
      send: vi
        .fn()
        .mockResolvedValue({ Item: { ...DISPATCH_ITEM, latitude: 41.2429, longitude: -73.2007 } }),
    } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.mapLink).toBe('https://www.google.com/maps/search/?api=1&query=41.2429%2C-73.2007');
  });

  it('returns 404 when no DISPATCH_ALERT item exists for the given dispatchId', async () => {
    const { createHandler } = await import('./handler.js');
    const docClient = { send: vi.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('missing-dispatch'));

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 503 and logs the original error when the DISPATCH_ALERT GetCommand throws (core content read, not pre-plan)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createHandler } = await import('./handler.js');
    class ProvisionedThroughputExceededException extends Error {}
    const docClient = {
      send: vi.fn().mockRejectedValue(new ProvisionedThroughputExceededException('throttled')),
    } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

    expect(result).toMatchObject({ statusCode: 503 });
    const logged = errorSpy.mock.calls.map((call) => call[0] as string).join('\n');
    expect(logged).toContain('throttled');
    expect(logged).toContain('dispatches.detail.read_failed');
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.detail).not.toContain('authorization service');
    expect(body.detail).toContain('alert data store');
    errorSpy.mockRestore();
  });

  it('returns 401 (fail-closed) for a missing bearer token before any DynamoDB call', async () => {
    const { createHandler } = await import('./handler.js');
    const sendSpy = vi.fn();
    const docClient = { send: sendSpy } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), docClient });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000', {}));

    expect(result).toMatchObject({ statusCode: 401 });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('returns 403 on a Cedar deny (cross-department access)', async () => {
    const { createHandler } = await import('./handler.js');
    const handler = createHandler({ authzClient: fakeAuthzClient('DENY') });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 (fail-closed, never a defaulted allow) when Verified Permissions is unavailable', async () => {
    const { createHandler } = await import('./handler.js');
    const authzClient = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    const handler = createHandler({ authzClient });

    const result = await handler(buildEvent('NICHOLS-4471-1798000000'));

    expect(result).toMatchObject({ statusCode: 503 });
  });
});
