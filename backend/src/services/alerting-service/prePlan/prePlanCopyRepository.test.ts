import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import geohash from 'ngeohash';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { normalizeAddress } from './addressKey.js';
import { hydrantGeoIndexKeys, prePlanAddressIndexKeys, prePlanGeoIndexKeys } from './copyKeys.js';
import {
  findNearestHydrants,
  findPrePlanByAddress,
  findPrePlanNear,
} from './prePlanCopyRepository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
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

describe('findPrePlanByAddress', () => {
  it('matches a differently spelled dispatch address to the pre-plan (Street/St, case, punctuation, city tail)', async () => {
    const { client, send } = fakeIndex([prePlanCopy('OCC-1', '123 Main Street')]);

    const found = await findPrePlanByAddress(client, TABLE, DEPT_ID, '123 main st., Trumbull CT');

    expect(found?.occupancyId).toBe('OCC-1');
    expect(send).toHaveBeenCalledOnce();
    const input = send.mock.calls[0]?.[0].input;
    expect(input?.IndexName).toBe('GSI1');
    expect(input?.ExpressionAttributeValues).toEqual({
      ':gsi1pk': 'DEPT#NICHOLS#PREPLAN_ADDR#123 MAIN ST',
    });
  });

  it('returns undefined when no pre-plan is on file for the address', async () => {
    const { client } = fakeIndex([prePlanCopy('OCC-1', '123 Main Street')]);
    expect(await findPrePlanByAddress(client, TABLE, DEPT_ID, '125 Main Street')).toBeUndefined();
  });

  it('does not query at all for an address with no street text', async () => {
    const { client, send } = fakeIndex([]);
    expect(await findPrePlanByAddress(client, TABLE, DEPT_ID, ' , ')).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('prefers the unit-matched pre-plan, then the building-level one, among occupancies sharing a street address', async () => {
    const { client } = fakeIndex([
      prePlanCopy('OCC-APT2', '40 Oak Ave Apt 2', { snapshotUpdatedAt: 9 }),
      prePlanCopy('OCC-BLDG', '40 Oak Ave', { snapshotUpdatedAt: 1 }),
      prePlanCopy('OCC-APT7', '40 Oak Ave Apt 7', { snapshotUpdatedAt: 5 }),
    ]);

    expect(
      (await findPrePlanByAddress(client, TABLE, DEPT_ID, '40 Oak Avenue #7'))?.occupancyId,
    ).toBe('OCC-APT7');
    expect((await findPrePlanByAddress(client, TABLE, DEPT_ID, '40 Oak Avenue'))?.occupancyId).toBe(
      'OCC-BLDG',
    );
    expect(
      (await findPrePlanByAddress(client, TABLE, DEPT_ID, '40 Oak Avenue Apt 3'))?.occupancyId,
    ).toBe('OCC-BLDG');
  });

  it('falls back to the most recently updated unit when there is no building-level pre-plan', async () => {
    const { client } = fakeIndex([
      prePlanCopy('OCC-APT2', '40 Oak Ave Apt 2', { snapshotUpdatedAt: 9 }),
      prePlanCopy('OCC-APT7', '40 Oak Ave Apt 7', { snapshotUpdatedAt: 5 }),
    ]);
    expect((await findPrePlanByAddress(client, TABLE, DEPT_ID, '40 Oak Ave'))?.occupancyId).toBe(
      'OCC-APT2',
    );
  });

  it('propagates a read failure to the caller (the detail handler degrades it)', async () => {
    const client = {
      send: vi.fn().mockRejectedValue(new Error('ThrottlingException')),
    } as unknown as DynamoDBDocumentClient;
    await expect(findPrePlanByAddress(client, TABLE, DEPT_ID, '1 Main St')).rejects.toThrow(
      'ThrottlingException',
    );
  });
});

describe('findPrePlanNear', () => {
  it('matches the occupancy within 50 m of the dispatch point, nearest first', async () => {
    const { client, send } = fakeIndex([
      prePlanCopy('OCC-45M', '1 A St', { location: offset(45) }),
      prePlanCopy('OCC-20M', '2 B St', { location: offset(0, -20) }),
    ]);

    const found = await findPrePlanNear(client, TABLE, DEPT_ID, ORIGIN);

    expect(found?.occupancyId).toBe('OCC-20M');
    // centre geohash7 cell + 8 neighbours
    expect(send).toHaveBeenCalledTimes(9);
    expect(send.mock.calls.every((call) => call[0].input.IndexName === 'GSI2')).toBe(true);
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

    expect((await findPrePlanNear(client, TABLE, DEPT_ID, dispatch))?.occupancyId).toBe('OCC-EDGE');
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

    const hydrants = await findNearestHydrants(client, TABLE, DEPT_ID, ORIGIN);

    expect(hydrants.map((h) => h.hydrantId)).toEqual(['H-50', 'H-100', 'H-200', 'H-300', 'H-400']);
    expect(hydrants.map((h) => h.distanceMeters)).toEqual([50, 100, 200, 300, 400]);
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

    const hydrants = await findNearestHydrants(client, TABLE, DEPT_ID, ORIGIN);

    expect(send).toHaveBeenCalledTimes(18);
    expect(hydrants.map((h) => h.hydrantId)).toEqual(['H-NEAR', 'H-FAR-1', 'H-FAR-2']);
  });

  it('returns an empty list when no hydrant copy is anywhere near', async () => {
    const { client } = fakeIndex([]);
    expect(await findNearestHydrants(client, TABLE, DEPT_ID, ORIGIN)).toEqual([]);
  });

  it('reads only HYDRANT_COPY items from the geo partitions', async () => {
    const { client } = fakeIndex([
      { ...hydrantCopy('H-1', offset(30)), entityType: 'SOMETHING_ELSE' },
      hydrantCopy('H-2', offset(60)),
    ]);
    const hydrants = await findNearestHydrants(client, TABLE, DEPT_ID, ORIGIN);
    expect(hydrants.map((h) => h.hydrantId)).toEqual(['H-2']);
  });
});
