import { describe, expect, it } from 'vitest';
import {
  flowClassFor,
  parseHydrantUpdatePayload,
  rankNearestHydrants,
  type HydrantCopy,
} from './nearestHydrants.js';

// Trumbull CT town green; one degree of latitude is ~111 km, so 0.001 deg lat is ~111 m.
const ORIGIN = { latitude: 41.2429, longitude: -73.2007 };
const north = (meters: number) => ORIGIN.latitude + meters / 111_320;

describe('parseHydrantUpdatePayload', () => {
  it('parses a well-formed inspections.hydrant.updated payload', () => {
    expect(
      parseHydrantUpdatePayload({
        hydrantId: 'HYD-0231',
        deptId: 'NICHOLS',
        status: 'IN_SERVICE',
        latitude: 41.24,
        longitude: -73.2,
        size: '6-inch',
        flowRatingGpm: 1250,
        nextFlowTestDue: '2027-01-10',
      }),
    ).toEqual({
      hydrantId: 'HYD-0231',
      deptId: 'NICHOLS',
      status: 'IN_SERVICE',
      latitude: 41.24,
      longitude: -73.2,
      size: '6-inch',
      flowRatingGpm: 1250,
    });
  });

  it('drops a half-present or out-of-range location rather than indexing a bogus point', () => {
    expect(
      parseHydrantUpdatePayload({ hydrantId: 'H', deptId: 'D', latitude: 41.2 }),
    ).not.toHaveProperty('latitude');
    expect(
      parseHydrantUpdatePayload({ hydrantId: 'H', deptId: 'D', latitude: 95, longitude: 0 }),
    ).not.toHaveProperty('latitude');
  });

  it('throws when hydrantId is missing', () => {
    expect(() => parseHydrantUpdatePayload({ deptId: 'NICHOLS' })).toThrow(/hydrantId/);
  });

  it('throws when deptId is missing', () => {
    expect(() => parseHydrantUpdatePayload({ hydrantId: 'HYD-0231' })).toThrow(/deptId/);
  });
});

describe('flowClassFor (NFPA 291)', () => {
  it.each([
    [2000, 'AA'],
    [1500, 'AA'],
    [1499, 'A'],
    [1000, 'A'],
    [999, 'B'],
    [500, 'B'],
    [499, 'C'],
    [0, 'C'],
  ])('%i gpm -> class %s', (gpm, flowClass) => {
    expect(flowClassFor(gpm)).toBe(flowClass);
  });

  it('is undefined when the flow rating is unknown', () => {
    expect(flowClassFor(undefined)).toBeUndefined();
    expect(flowClassFor(-1)).toBeUndefined();
  });
});

describe('rankNearestHydrants', () => {
  const at = (hydrantId: string, meters: number, extra: Partial<HydrantCopy> = {}) => ({
    hydrantId,
    latitude: north(meters),
    longitude: ORIGIN.longitude,
    ...extra,
  });

  it('orders by distance, nearest first, with the distance in whole meters', () => {
    const result = rankNearestHydrants(ORIGIN, [
      at('HYD-FAR', 400),
      at('HYD-NEAR', 60),
      at('HYD-MID', 150),
    ]);
    expect(result.map((h) => h.hydrantId)).toEqual(['HYD-NEAR', 'HYD-MID', 'HYD-FAR']);
    expect(result.map((h) => h.distanceMeters)).toEqual([60, 150, 400]);
  });

  it('returns at most five by default', () => {
    const candidates = Array.from({ length: 9 }, (_, i) => at(`HYD-${i}`, (9 - i) * 50));
    const result = rankNearestHydrants(ORIGIN, candidates);
    expect(result).toHaveLength(5);
    expect(result.map((h) => h.hydrantId)).toEqual(['HYD-8', 'HYD-7', 'HYD-6', 'HYD-5', 'HYD-4']);
  });

  it('never offers an OUT_OF_SERVICE hydrant, and lets the next one take its place', () => {
    const result = rankNearestHydrants(
      ORIGIN,
      [
        at('HYD-OOS', 10, { status: 'OUT_OF_SERVICE' }),
        at('HYD-OK', 200, { status: 'IN_SERVICE' }),
      ],
      1,
    );
    expect(result.map((h) => h.hydrantId)).toEqual(['HYD-OK']);
  });

  it('skips copies with no usable location', () => {
    const result = rankNearestHydrants(ORIGIN, [
      { hydrantId: 'HYD-NOWHERE', status: 'IN_SERVICE' },
      at('HYD-1', 100),
    ]);
    expect(result.map((h) => h.hydrantId)).toEqual(['HYD-1']);
  });

  it('carries status, size, flow rating and NFPA flow class when known', () => {
    const [hydrant] = rankNearestHydrants(ORIGIN, [
      at('HYD-1', 100, { status: 'IN_SERVICE', size: '6-inch', flowRatingGpm: 1100 }),
    ]);
    expect(hydrant).toMatchObject({
      hydrantId: 'HYD-1',
      status: 'IN_SERVICE',
      size: '6-inch',
      flowRatingGpm: 1100,
      flowClass: 'A',
      distanceMeters: 100,
    });
  });

  it('breaks exact-distance ties on hydrantId and drops duplicate ids from overlapping cells', () => {
    const result = rankNearestHydrants(ORIGIN, [
      at('HYD-B', 100),
      at('HYD-A', 100),
      at('HYD-A', 100),
    ]);
    expect(result.map((h) => h.hydrantId)).toEqual(['HYD-A', 'HYD-B']);
  });
});
