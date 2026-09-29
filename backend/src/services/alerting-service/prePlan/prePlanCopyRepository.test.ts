import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import geohash from 'ngeohash';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { normalizeAddress } from './addressKey.js';
import { NO_HOME_LOCALITY, parseHomeLocality } from './locality.js';
import { hydrantGeoIndexKeys, prePlanAddressIndexKeys, prePlanGeoIndexKeys } from './copyKeys.js';
import {
  findNearestHydrants,
  findPrePlanByAddress,
  findPrePlanNear,
  MAX_HYDRANTS_PER_CELL,
  PrePlanLookupIncompleteError,
  type PrePlanMatch,
} from './prePlanCopyRepository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const HOME = parseHomeLocality({
  towns: ['Trumbull', 'Nichols', 'Long Hill', 'Trumbull Center'],
  zips: ['06611'],
  state: 'CT',
})!;
const TABLE = 'alerting-table';
const ORIGIN = { latitude: 41.2429, longitude: -73.2007 };
const METERS_PER_DEG_LAT = 111_320;
const METERS_PER_DEG_LON = METERS_PER_DEG_LAT * Math.cos((ORIGIN.latitude * Math.PI) / 180);

function offset(northMeters: number, eastMeters = 0) {
  return {
    latitude: ORIGIN.latitude + northMeters / METERS_PER_DEG_LAT,
    longitude: ORIGIN.longitude + eastMeters / METERS_PER_DEG_LON,
  };
}

interface QueryInput {
  readonly IndexName: string;
  readonly ExpressionAttributeValues: Record<string, string>;
  readonly Limit?: number;
}

/** A tiny in-memory GSI1/GSI2: answers the Queries the repository issues from `items`. */
function fakeIndex(items: Record<string, unknown>[]) {
  const send = vi.fn((command: { input: QueryInput }) => {
    const { IndexName, ExpressionAttributeValues: values } = command.input;
    const matches =
      IndexName === 'GSI1'
        ? items.filter((item) => item.gsi1pk === values[':gsi1pk'])
        : items.filter(
            (item) =>
              item.gsi2pk === values[':gsi2pk'] &&
              String(item.gsi2sk).startsWith(values[':cell'] ?? ''),
          );
    return Promise.resolve({ Items: matches });
  });
  return { send, client: { send } as unknown as DynamoDBDocumentClient };
}

function prePlanCopy(
  occupancyId: string,
  address: string,
  extra: { location?: { latitude: number; longitude: number }; snapshotUpdatedAt?: number } = {},
) {
  const normalized = normalizeAddress(address);
  return {
    pk: 'DEPT#NICHOLS#PREPLAN',
    sk: `OCCUPANCY#${occupancyId}`,
    entityType: 'PRE_PLAN_COPY',
    occupancyId,
    address,
    summary: `Pre-plan for ${address}`,
    hazards: [],
    utilityShutoffs: [],
    snapshotUpdatedAt: extra.snapshotUpdatedAt ?? 1,
    ...(normalized?.unit ? { addressUnit: normalized.unit } : {}),
    ...(normalized?.town ? { addressTown: normalized.town } : {}),
    ...(normalized?.zip ? { addressZip: normalized.zip } : {}),
    ...(normalized ? prePlanAddressIndexKeys(DEPT_ID, normalized.key, occupancyId) : {}),
    ...(extra.location
      ? { ...extra.location, ...prePlanGeoIndexKeys(DEPT_ID, extra.location, occupancyId) }
      : {}),
  };
}

function hydrantCopy(
  hydrantId: string,
  location: { latitude: number; longitude: number },
  extra = {},
) {
  return {
    pk: 'DEPT#NICHOLS#HYDRANT',
    sk: `HYDRANT#${hydrantId}`,
    entityType: 'HYDRANT_COPY',
    hydrantId,
    status: 'IN_SERVICE',
    ...location,
    ...hydrantGeoIndexKeys(DEPT_ID, location, hydrantId),
    ...extra,
  };
}

/** The single matched occupancy, or undefined (no match / candidates). */
function matchedId(match: PrePlanMatch | undefined): string | undefined {
  return match && match.matchType !== 'CANDIDATES' ? match.copy.occupancyId : undefined;
}

describe('findPrePlanByAddress', () => {
  it('matches a differently spelled dispatch address to the pre-plan (Street/St, case, punctuation, city tail)', async () => {
    const { client, send } = fakeIndex([prePlanCopy('OCC-1', '123 Main Street')]);

    const found = await findPrePlanByAddress(
      client,
      TABLE,
      DEPT_ID,
      '123 main st., Trumbull CT',
      undefined,
      HOME,
    );

    expect(found).toMatchObject({ matchType: 'ADDRESS', copy: { occupancyId: 'OCC-1' } });
    expect(send).toHaveBeenCalledOnce();
    const input = send.mock.calls[0]?.[0].input;
    expect(input?.IndexName).toBe('GSI1');
    expect(input?.ExpressionAttributeValues).toEqual({
      ':gsi1pk': 'DEPT#NICHOLS#PREPLAN_ADDR#123 MAIN ST',
    });
  });

  it('returns undefined when no pre-plan is on file for the address', async () => {
    const { client } = fakeIndex([prePlanCopy('OCC-1', '123 Main Street')]);
    expect(
      await findPrePlanByAddress(client, TABLE, DEPT_ID, '125 Main Street', undefined, HOME),
    ).toBeUndefined();
  });

  it('does not query at all for an address with no street text', async () => {
    const { client, send } = fakeIndex([]);
    expect(
      await findPrePlanByAddress(client, TABLE, DEPT_ID, ' , ', undefined, HOME),
    ).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  describe('unit resolution (MAJOR-3: never silently pick one of several unit plans)', () => {
    const apt = (unit: string, updated = 1) =>
      prePlanCopy(`OCC-APT${unit}`, `40 Oak Ave Apt ${unit}`, { snapshotUpdatedAt: updated });
    const building = prePlanCopy('OCC-BLDG', '40 Oak Ave');
    // The dispatcher chose Trumbull (a home town), so locality is verified.
    const lookup = async (items: Record<string, unknown>[], address: string) =>
      findPrePlanByAddress(fakeIndex(items).client, TABLE, DEPT_ID, address, undefined, HOME, {
        town: 'Trumbull',
      });

    it('returns the exact unit match as ADDRESS', async () => {
      expect(await lookup([apt('2'), building, apt('7')], '40 Oak Avenue #7')).toMatchObject({
        matchType: 'ADDRESS',
        copy: { occupancyId: 'OCC-APT7' },
      });
    });

    it('returns the building-level plan as ADDRESS when the dispatch names no unit', async () => {
      expect(await lookup([apt('2'), building], '40 Oak Avenue')).toMatchObject({
        matchType: 'ADDRESS',
        copy: { occupancyId: 'OCC-BLDG' },
      });
    });

    it('returns the building-level plan as ADDRESS_BUILDING for a unit with no plan of its own, naming that unit', async () => {
      expect(await lookup([apt('2'), building], '40 Oak Avenue Apt 3')).toMatchObject({
        matchType: 'ADDRESS_BUILDING',
        copy: { occupancyId: 'OCC-BLDG' },
        dispatchUnit: 'APT 3',
      });
    });

    it.each([
      ['100 Industrial Dr Bldg 2', '100 Industrial Dr', 'BLDG 2'],
      ['100 Industrial Dr Building B', '100 Industrial Dr', 'BUILDING B'],
      ['12 Main St Rear', '12 Main St', 'REAR'],
      ['55 Park Ln Lot 12', '55 Park Ln', 'LOT 12'],
    ])(
      'R3-C: %s against the main building plan names the structure (%s -> %s)',
      async (dispatch, onFile, label) => {
        expect(await lookup([prePlanCopy('OCC-MAIN', onFile)], dispatch)).toMatchObject({
          matchType: 'ADDRESS_BUILDING',
          dispatchUnit: label,
        });
      },
    );

    it('flags a lone plan for a different unit as UNIT_MISMATCH', async () => {
      expect(await lookup([apt('2')], '40 Oak Avenue Apt 3')).toMatchObject({
        matchType: 'UNIT_MISMATCH',
        copy: { occupancyId: 'OCC-APT2' },
      });
      expect(await lookup([apt('2')], '40 Oak Avenue')).toMatchObject({
        matchType: 'UNIT_MISMATCH',
      });
    });

    it('returns every unit plan as CANDIDATES instead of the newest one (strip-mall case)', async () => {
      for (const address of ['40 Oak Ave', '40 Oak Ave Unit C']) {
        const match = await lookup([apt('A', 9), apt('B', 1)], address);
        expect(match?.matchType).toBe('CANDIDATES');
        expect(
          match?.matchType === 'CANDIDATES'
            ? match.candidates.map((c) => c.copy.addressUnit)
            : undefined,
        ).toEqual(['A', 'B']);
      }
    });

    it('returns duplicates of one unit (or two building-level plans) as CANDIDATES', async () => {
      const dupe = prePlanCopy('OCC-BLDG-2', '40 Oak Avenue');
      expect((await lookup([building, dupe], '40 Oak Ave'))?.matchType).toBe('CANDIDATES');
      const dupeUnit = prePlanCopy('OCC-APT2-B', '40 Oak Ave #2');
      expect((await lookup([apt('2'), dupeUnit], '40 Oak Ave Apt 2'))?.matchType).toBe(
        'CANDIDATES',
      );
    });
  });

  it('propagates a read failure to the caller (the detail handler degrades it)', async () => {
    const client = {
      send: vi.fn().mockRejectedValue(new Error('ThrottlingException')),
    } as unknown as DynamoDBDocumentClient;
    await expect(
      findPrePlanByAddress(client, TABLE, DEPT_ID, '1 Main St', undefined, HOME),
    ).rejects.toThrow('ThrottlingException');
  });
});

describe('findPrePlanByAddress — locality against the home set (round-2 A)', () => {
  const byAddress = (
    items: Record<string, unknown>[],
    address: string,
    home = HOME,
    locality?: { town: string },
  ) =>
    findPrePlanByAddress(
      fakeIndex(items).client,
      TABLE,
      DEPT_ID,
      address,
      undefined,
      home,
      locality,
    );

  it('never matches a town-less home pre-plan to a dispatch in another town (mutual aid to Bridgeport)', async () => {
    const trumbull = [prePlanCopy('OCC-T', '123 Main St')];
    expect(await byAddress(trumbull, '123 Main St, Bridgeport, CT')).toBeUndefined();
    expect(await byAddress(trumbull, '123 MAIN ST BRIDGEPORT CT')).toBeUndefined();
    expect(await byAddress(trumbull, '123 Main St, Stratford, CT 06614')).toBeUndefined();
    expect(await byAddress(trumbull, '123 Main St, CT 06604')).toBeUndefined();
    expect(await byAddress(trumbull, '123 Main St, Springfield, MA')).toBeUndefined();
  });

  it('verifies a town-less pre-plan for a dispatch naming a home town, village or ZIP', async () => {
    const trumbull = [prePlanCopy('OCC-T', '123 Main St')];
    for (const address of [
      '123 Main St, Trumbull, CT',
      '123 MAIN ST TRUMBULL CT 06611',
      '123 Main St Nichols',
      '123 Main St, Nichols, CT',
      '123 Main St, Long Hill',
      '123 Main St, CT 06611',
    ]) {
      expect(await byAddress(trumbull, address), address).toMatchObject({
        matchType: 'ADDRESS',
        copy: { occupancyId: 'OCC-T' },
      });
    }
  });

  describe('R3-A: a dispatch naming no locality is never verified', () => {
    it('"123 Main St" alone is ADDRESS_UNVERIFIED — it could be a mutual-aid call anywhere', async () => {
      expect(await byAddress([prePlanCopy('OCC-T', '123 Main St')], '123 Main St')).toMatchObject({
        matchType: 'ADDRESS_UNVERIFIED',
      });
    });

    it("the dispatcher's home locality choice verifies it", async () => {
      const trumbull = [prePlanCopy('OCC-T', '123 Main St')];
      for (const town of ['Trumbull', 'Nichols', 'Long Hill', 'Trumbull Center']) {
        expect(await byAddress(trumbull, '123 Main St', HOME, { town }), town).toMatchObject({
          matchType: 'ADDRESS',
        });
      }
    });

    it('an "Other town" choice never matches a home pre-plan', async () => {
      const trumbull = [prePlanCopy('OCC-T', '123 Main St')];
      expect(
        await byAddress(trumbull, '123 Main St', HOME, { town: 'Bridgeport' }),
      ).toBeUndefined();
      // An unrecognized typed town is still a town outside the home set.
      expect(await byAddress(trumbull, '123 Main St', HOME, { town: 'Bpt' })).toBeUndefined();
    });

    it('an address naming one town and a locality choice naming another is flagged, not resolved', async () => {
      expect(
        await byAddress(
          [prePlanCopy('OCC-M', '123 Main St, Monroe, CT')],
          '123 Main St, Monroe, CT',
          HOME,
          { town: 'Trumbull' },
        ),
      ).toMatchObject({ matchType: 'ADDRESS_UNVERIFIED' });
    });
  });

  it('N9: home villages agree with the home town (Nichols vs Trumbull, same ZIP)', async () => {
    const copy = [prePlanCopy('OCC-T', '123 Main St, Trumbull, CT 06611')];
    expect(await byAddress(copy, '123 Main St, Nichols, CT 06611')).toMatchObject({
      matchType: 'ADDRESS',
    });
    expect(await byAddress(copy, '123 Main St, Long Hill, CT')).toMatchObject({
      matchType: 'ADDRESS',
    });
  });

  it('a copy outside the home area matches a town-less dispatch only flagged ADDRESS_UNVERIFIED', async () => {
    const monroe = [prePlanCopy('OCC-M', '123 Main St, Monroe, CT')];
    expect(await byAddress(monroe, '123 Main St')).toMatchObject({
      matchType: 'ADDRESS_UNVERIFIED',
      copy: { occupancyId: 'OCC-M' },
    });
    expect(await byAddress(monroe, '123 Main St, Monroe, CT')).toMatchObject({
      matchType: 'ADDRESS',
    });
  });

  it('with no home locality configured, nothing is verified: every address match is flagged', async () => {
    const trumbull = [prePlanCopy('OCC-T', '123 Main St')];
    expect(await byAddress(trumbull, '123 Main St', NO_HOME_LOCALITY)).toMatchObject({
      matchType: 'ADDRESS_UNVERIFIED',
    });
    expect(await byAddress(trumbull, '123 Main St, Trumbull, CT', NO_HOME_LOCALITY)).toMatchObject({
      matchType: 'ADDRESS_UNVERIFIED',
    });
  });

  it('rejects an address match more than 150 m from the dispatch coordinates', async () => {
    const { client } = fakeIndex([
      prePlanCopy('OCC-FAR', '123 Main St', { location: offset(400) }),
    ]);
    expect(
      await findPrePlanByAddress(client, TABLE, DEPT_ID, '123 Main St', ORIGIN, HOME),
    ).toBeUndefined();
    expect(
      matchedId(
        await findPrePlanByAddress(client, TABLE, DEPT_ID, '123 Main St', offset(350), HOME),
      ),
    ).toBe('OCC-FAR');
  });

  it('never trusts a stored unit written by older rules — the unit is re-read from the address', async () => {
    const stale = { ...prePlanCopy('OCC-LOT', '100 Lot Rd'), addressUnit: 'RD' };
    expect(await byAddress([stale], '100 Lot Rd', HOME, { town: 'Trumbull' })).toMatchObject({
      matchType: 'ADDRESS',
    });
  });
});

describe("no unflagged false match (round-2 B: the reviewer's examples)", () => {
  const UNFLAGGED = new Set(['ADDRESS', 'ADDRESS_BUILDING']);
  // [pre-plan on file, dispatch] — different places that older rules gave one key.
  const pairs: Array<[string, string]> = [
    ['123 Mount St', '123 Mount St Joseph Rd'],
    ['123 Mount St Joseph Rd', '123 Mount St'],
    ['123 Mill Run', '123 Mill Run Rd'],
    ['123 Fox Run', '123 Fox Run Rd'],
    ['123 Kings Hwy', '123 Kings Hwy Cutoff'],
    ['123 Kings Hwy Cutoff', '123 Kings Hwy'],
    ['123 Village Sq', '123 Village Sq Dr'],
    ['2 Lakeview Ter', '2 Lakeview Ter Way'],
    ['12 Main St N', '12 Main St North Haven CT'],
    ['12 Main St W', '12 Main St West Haven'],
    ['12 Main St', '12 Main St North Haven CT'],
    ['12 Main St', '12 Main St West Haven'],
    ['12 Main St', '12 Main St New Haven CT 06510'],
    ['123 Main St', '123 Main St, Bridgeport, CT'],
    ['123 Main St', '123 Main St Stratford'],
    ['123 US Hwy 1', '123 US Hwy 11'],
    ['123 Route 111', '123 Route 25'],
    ['12 Main St', '12A Main St'],
    ['100 Lot Rd', '100 Space Ln'],
    ['123 Main St', '123 Main St, Springfield, MA'],
  ];

  it.each(pairs)(
    'pre-plan %j is never an unflagged match for dispatch %j',
    async (onFile, dispatch) => {
      // Index the copy under every key either address could produce, so only the matcher decides.
      const copy = prePlanCopy('OCC-ON-FILE', onFile);
      const dispatchKey = normalizeAddress(dispatch)?.key;
      const items = [
        copy,
        ...(dispatchKey
          ? [{ ...copy, ...prePlanAddressIndexKeys(DEPT_ID, dispatchKey, 'OCC-ON-FILE') }]
          : []),
      ];
      const match = await findPrePlanByAddress(
        fakeIndex(items).client,
        TABLE,
        DEPT_ID,
        dispatch,
        undefined,
        HOME,
      );
      expect(match === undefined || !UNFLAGGED.has(match.matchType), JSON.stringify(match)).toBe(
        true,
      );
    },
  );

  it('flags (rather than drops) a same-key match whose parse involved a guess', async () => {
    const match = await findPrePlanByAddress(
      fakeIndex([prePlanCopy('OCC-K', '123 Kings Hwy')]).client,
      TABLE,
      DEPT_ID,
      '123 Kings Hwy Cutoff',
      undefined,
      HOME,
    );
    expect(match).toMatchObject({ matchType: 'ADDRESS_UNVERIFIED' });
  });

  it('still verifies the same place written differently', async () => {
    for (const [onFile, dispatch] of [
      ['123 Mount St Joseph Rd', '123 MOUNT SAINT JOSEPH ROAD'],
      ['123 Route 111', '123 CT-111'],
      ['12 Main St', '12 MAIN ST TRUMBULL CT 06611'],
      ['12 Main St', '12 Main Street Rear'],
    ] as const) {
      const match = await findPrePlanByAddress(
        fakeIndex([prePlanCopy('OCC-SAME', onFile)]).client,
        TABLE,
        DEPT_ID,
        dispatch,
        undefined,
        HOME,
        { town: 'Trumbull' },
      );
      expect(match?.matchType, `${onFile} vs ${dispatch}`).toMatch(/^ADDRESS(_BUILDING)?$/);
    }
  });
});

describe('findPrePlanNear', () => {
  it('returns a lone occupancy within 50 m as NEARBY, with its distance', async () => {
    const { client, send } = fakeIndex([
      prePlanCopy('OCC-45M', '1 A St', { location: offset(45) }),
      prePlanCopy('OCC-90M', '9 C St', { location: offset(90) }),
    ]);

    const found = await findPrePlanNear(client, TABLE, DEPT_ID, ORIGIN);

    expect(found).toMatchObject({
      matchType: 'NEARBY',
      copy: { occupancyId: 'OCC-45M' },
      distanceMeters: 45,
    });
    // centre geohash7 cell + 8 neighbours
    expect(send).toHaveBeenCalledTimes(9);
    expect(send.mock.calls.every((call) => call[0].input.IndexName === 'GSI2')).toBe(true);
  });

  it('returns several occupancies within 50 m as CANDIDATES, nearest first — never just the nearest', async () => {
    const { client } = fakeIndex([
      prePlanCopy('OCC-45M', '1 A St', { location: offset(45) }),
      prePlanCopy('OCC-20M', '2 B St', { location: offset(0, -20) }),
    ]);

    const found = await findPrePlanNear(client, TABLE, DEPT_ID, ORIGIN);

    expect(found?.matchType).toBe('CANDIDATES');
    expect(
      found?.matchType === 'CANDIDATES'
        ? found.candidates.map((c) => [c.copy.occupancyId, c.distanceMeters])
        : undefined,
    ).toEqual([
      ['OCC-20M', 20],
      ['OCC-45M', 45],
    ]);
  });

  it('does not match an occupancy farther than 50 m', async () => {
    const { client } = fakeIndex([prePlanCopy('OCC-80M', '1 A St', { location: offset(80) })]);
    expect(await findPrePlanNear(client, TABLE, DEPT_ID, ORIGIN)).toBeUndefined();
  });

  it('finds an occupancy just across a geohash cell edge from the dispatch point', async () => {
    // Put the occupancy 10 m north of its geohash7 cell's southern edge and the dispatch 10 m
    // south of it: 20 m apart, in different cells — a single-cell lookup would miss it.
    const [minLat] = geohash.decode_bbox(geohash.encode(ORIGIN.latitude, ORIGIN.longitude, 7));
    const occupancy = { latitude: minLat + 10 / METERS_PER_DEG_LAT, longitude: ORIGIN.longitude };
    const dispatch = { latitude: minLat - 10 / METERS_PER_DEG_LAT, longitude: ORIGIN.longitude };
    expect(geohash.encode(dispatch.latitude, dispatch.longitude, 7)).not.toBe(
      geohash.encode(occupancy.latitude, occupancy.longitude, 7),
    );
    const { client } = fakeIndex([prePlanCopy('OCC-EDGE', '1 A St', { location: occupancy })]);

    expect(matchedId(await findPrePlanNear(client, TABLE, DEPT_ID, dispatch))).toBe('OCC-EDGE');
  });
});

describe('findNearestHydrants', () => {
  it('returns the five nearest usable hydrants, nearest first, with distances', async () => {
    const { client } = fakeIndex([
      hydrantCopy('H-300', offset(300)),
      hydrantCopy('H-100', offset(0, 100)),
      hydrantCopy('H-OOS', offset(10), { status: 'OUT_OF_SERVICE' }),
      hydrantCopy('H-200', offset(-200)),
      hydrantCopy('H-50', offset(50)),
      hydrantCopy('H-400', offset(0, -400)),
      hydrantCopy('H-450', offset(450)),
    ]);

    const { hydrants } = await findNearestHydrants(client, TABLE, DEPT_ID, ORIGIN);

    // H-OOS (10 m) is flagged, not counted: five usable hydrants follow it.
    expect(hydrants.map((h) => h.hydrantId)).toEqual([
      'H-OOS',
      'H-50',
      'H-100',
      'H-200',
      'H-300',
      'H-400',
    ]);
    expect(hydrants[0]?.status).toBe('OUT_OF_SERVICE');
    expect(hydrants.map((h) => h.distanceMeters)).toEqual([10, 50, 100, 200, 300, 400]);
  });

  it('stops at the geohash6 ring when it already holds five hydrants inside its covered radius', async () => {
    const { client, send } = fakeIndex(
      [50, 100, 150, 200, 250].map((m) => hydrantCopy(`H-${m}`, offset(m))),
    );
    await findNearestHydrants(client, TABLE, DEPT_ID, ORIGIN);
    expect(send).toHaveBeenCalledTimes(9);
  });

  it('widens to the geohash5 ring when the close ring is sparse (rural), still nearest first', async () => {
    const { client, send } = fakeIndex([
      hydrantCopy('H-FAR-2', offset(2500)),
      hydrantCopy('H-NEAR', offset(80)),
      hydrantCopy('H-FAR-1', offset(0, 1800)),
    ]);

    const { hydrants } = await findNearestHydrants(client, TABLE, DEPT_ID, ORIGIN);

    expect(send).toHaveBeenCalledTimes(18);
    expect(hydrants.map((h) => h.hydrantId)).toEqual(['H-NEAR', 'H-FAR-1', 'H-FAR-2']);
  });

  it('bounds every hydrant cell read (minor 10): Limit per query, so the widened rural ring cannot read the whole department', async () => {
    const { client, send } = fakeIndex([hydrantCopy('H-FAR', offset(2500))]);

    await findNearestHydrants(client, TABLE, DEPT_ID, ORIGIN);

    // Both rings (geohash6 then geohash5): 18 queries, every one capped.
    expect(send).toHaveBeenCalledTimes(18);
    for (const call of send.mock.calls) {
      expect((call[0].input as { Limit?: number }).Limit).toBe(MAX_HYDRANTS_PER_CELL);
    }
  });

  it('round-2 C: a truncated wide read never loses the close hydrants the narrow ring found', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const close = [hydrantCopy('H-CLOSE-1', offset(300)), hydrantCopy('H-CLOSE-2', offset(0, 400))];
    const far = hydrantCopy('H-FAR', offset(2500));
    // Narrow (geohash6) cells answer normally; every wide (geohash5) cell is "dense": it returns
    // only the far hydrant and claims more, as a capped read would.
    const send = vi.fn(
      (command: { input: { ExpressionAttributeValues: Record<string, string> } }) => {
        const cell = command.input.ExpressionAttributeValues[':cell'] ?? '';
        if (cell.length === 5) {
          return Promise.resolve({ Items: [far], LastEvaluatedKey: { pk: 'more' } });
        }
        return Promise.resolve({
          Items: close.filter(
            (h) =>
              h.gsi2pk === command.input.ExpressionAttributeValues[':gsi2pk'] &&
              h.gsi2sk.startsWith(cell),
          ),
        });
      },
    );

    const result = await findNearestHydrants(
      { send } as unknown as DynamoDBDocumentClient,
      TABLE,
      DEPT_ID,
      ORIGIN,
    );

    expect(result.incomplete).toBe(true);
    expect(result.hydrants.map((h) => h.hydrantId)).toEqual(['H-CLOSE-1', 'H-CLOSE-2', 'H-FAR']);
    vi.restoreAllMocks();
  });

  it('returns an empty list when no hydrant copy is anywhere near', async () => {
    const { client } = fakeIndex([]);
    expect(await findNearestHydrants(client, TABLE, DEPT_ID, ORIGIN)).toEqual({
      hydrants: [],
      incomplete: false,
    });
  });

  it('reads only HYDRANT_COPY items from the geo partitions', async () => {
    const { client } = fakeIndex([
      { ...hydrantCopy('H-1', offset(30)), entityType: 'SOMETHING_ELSE' },
      hydrantCopy('H-2', offset(60)),
    ]);
    const { hydrants } = await findNearestHydrants(client, TABLE, DEPT_ID, ORIGIN);
    expect(hydrants.map((h) => h.hydrantId)).toEqual(['H-2']);
  });
});

describe('capped reads are reported, never silent (minor 9)', () => {
  /** Every Query returns one item and claims there is more, so every read hits its cap. */
  function endlessIndex(item: Record<string, unknown>) {
    const send = vi.fn(() => Promise.resolve({ Items: [item], LastEvaluatedKey: { pk: 'more' } }));
    return { send, client: { send } as unknown as DynamoDBDocumentClient };
  }

  it('N7: an address lookup that hits its cap is "unavailable" (throws), never "no match", and says why', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { client, send } = endlessIndex(prePlanCopy('OCC-1', '123 Main St'));

    await expect(
      findPrePlanByAddress(client, TABLE, DEPT_ID, '123 Main St', undefined, HOME),
    ).rejects.toBeInstanceOf(PrePlanLookupIncompleteError);

    expect(send).toHaveBeenCalledTimes(5);
    expect(errorSpy.mock.calls.join('\n')).toContain('preplan_copy.query_truncated');
    expect(logSpy.mock.calls.join('\n')).toContain('CopyQueryTruncated');
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('a hydrant search that hits its cap returns what it found, marked incomplete', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { client } = endlessIndex(hydrantCopy('H-1', offset(30)));

    const result = await findNearestHydrants(client, TABLE, DEPT_ID, ORIGIN);

    expect(result.incomplete).toBe(true);
    expect(result.hydrants.map((h) => h.hydrantId)).toEqual(['H-1']);
    expect(errorSpy.mock.calls.join('\n')).toContain('hydrant-geo');
    errorSpy.mockRestore();
  });
});
