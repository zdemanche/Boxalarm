import { describe, expect, it } from 'vitest';
import { parseHydrantUpdatePayload, resolveNearestHydrants } from './nearestHydrants.js';

describe('parseHydrantUpdatePayload', () => {
  it('parses a well-formed inspections.hydrant.updated payload', () => {
    const parsed = parseHydrantUpdatePayload({
      hydrantId: 'HYD-0231',
      deptId: 'NICHOLS',
      status: 'IN_SERVICE',
      latitude: 41.24,
      longitude: -73.2,
    });
    expect(parsed).toEqual({
      hydrantId: 'HYD-0231',
      deptId: 'NICHOLS',
      status: 'IN_SERVICE',
      latitude: 41.24,
      longitude: -73.2,
      size: undefined,
      flowRatingGpm: undefined,
    });
  });

  it('throws when hydrantId is missing', () => {
    expect(() => parseHydrantUpdatePayload({ deptId: 'NICHOLS' })).toThrow(/hydrantId/);
  });

  it('throws when deptId is missing', () => {
    expect(() => parseHydrantUpdatePayload({ hydrantId: 'HYD-0231' })).toThrow(/deptId/);
  });
});

describe('resolveNearestHydrants (AC2)', () => {
  it('refreshes an already-referenced hydrant in place, preserving list order', () => {
    const existing = [
      { hydrantId: 'HYD-01', status: 'IN_SERVICE', latitude: 1, longitude: 1 },
      { hydrantId: 'HYD-02', status: 'IN_SERVICE', latitude: 2, longitude: 2 },
    ];

    const result = resolveNearestHydrants(
      existing,
      { hydrantId: 'HYD-02', deptId: 'NICHOLS', status: 'OUT_OF_SERVICE' },
      null,
    );

    expect(result.map((h) => h.hydrantId)).toEqual(['HYD-01']);
  });

  it('refreshes flow/size fields in place without pruning when status stays in service', () => {
    const existing = [{ hydrantId: 'HYD-02', status: 'IN_SERVICE', flowRatingGpm: 800 }];

    const result = resolveNearestHydrants(
      existing,
      { hydrantId: 'HYD-02', deptId: 'NICHOLS', status: 'IN_SERVICE', flowRatingGpm: 1000 },
      null,
    );

    expect(result).toEqual([{ hydrantId: 'HYD-02', status: 'IN_SERVICE', flowRatingGpm: 1000 }]);
  });

  it('prunes a hydrant marked OUT_OF_SERVICE from the copy', () => {
    const existing = [{ hydrantId: 'HYD-02', status: 'IN_SERVICE' }];

    const result = resolveNearestHydrants(
      existing,
      { hydrantId: 'HYD-02', deptId: 'NICHOLS', status: 'OUT_OF_SERVICE' },
      null,
    );

    expect(result).toEqual([]);
  });

  it('returns the existing list unchanged when referenceLocation is null and the hydrant is not already referenced', () => {
    const existing = [{ hydrantId: 'HYD-01', status: 'IN_SERVICE' }];

    const result = resolveNearestHydrants(
      existing,
      { hydrantId: 'HYD-99', deptId: 'NICHOLS', status: 'IN_SERVICE', latitude: 5, longitude: 5 },
      null,
    );

    expect(result).toBe(existing);
  });

  it('inserts a new hydrant by distance when a referenceLocation and coordinates are both present', () => {
    const existing = [{ hydrantId: 'HYD-FAR', latitude: 10, longitude: 10 }];

    const result = resolveNearestHydrants(
      existing,
      {
        hydrantId: 'HYD-NEAR',
        deptId: 'NICHOLS',
        status: 'IN_SERVICE',
        latitude: 0.01,
        longitude: 0.01,
      },
      { latitude: 0, longitude: 0 },
    );

    expect(result.map((h) => h.hydrantId)).toEqual(['HYD-NEAR', 'HYD-FAR']);
  });

  it('caps the ranked list at maxResults', () => {
    const existing = Array.from({ length: 5 }, (_, i) => ({
      hydrantId: `HYD-${i}`,
      latitude: i + 1,
      longitude: i + 1,
    }));

    const result = resolveNearestHydrants(
      existing,
      { hydrantId: 'HYD-NEW', deptId: 'NICHOLS', status: 'IN_SERVICE', latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0 },
      3,
    );

    expect(result).toHaveLength(3);
    expect(result[0]?.hydrantId).toBe('HYD-NEW');
  });
});
