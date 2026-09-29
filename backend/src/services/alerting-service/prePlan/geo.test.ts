import { describe, expect, it } from 'vitest';
import { encodeGeohash, haversineMeters, isGeoPoint, searchRing } from './geo.js';

const TRUMBULL = { latitude: 41.2429, longitude: -73.2007 };

describe('haversineMeters', () => {
  it('is zero for the same point and ~111 m per 0.001 deg of latitude', () => {
    expect(haversineMeters(TRUMBULL, TRUMBULL)).toBe(0);
    const d = haversineMeters(TRUMBULL, { ...TRUMBULL, latitude: TRUMBULL.latitude + 0.001 });
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });
});

describe('isGeoPoint', () => {
  it('accepts a finite in-range pair and rejects anything else', () => {
    expect(isGeoPoint(TRUMBULL)).toBe(true);
    expect(isGeoPoint({ latitude: 41 })).toBe(false);
    expect(isGeoPoint({ latitude: '41', longitude: -73 })).toBe(false);
    expect(isGeoPoint({ latitude: 91, longitude: 0 })).toBe(false);
    expect(isGeoPoint({ latitude: 0, longitude: -181 })).toBe(false);
    expect(isGeoPoint({ latitude: Number.NaN, longitude: 0 })).toBe(false);
  });
});

describe('searchRing', () => {
  it('is the centre cell plus its eight neighbours at the requested precision', () => {
    const ring = searchRing(TRUMBULL, 6);
    expect(ring.cells).toHaveLength(9);
    expect(ring.cells[0]).toBe(encodeGeohash(TRUMBULL, 6));
    expect(new Set(ring.cells).size).toBe(9);
    for (const cell of ring.cells) expect(cell).toHaveLength(6);
  });

  it('guarantees the pre-plan match radius at geohash7 and ~0.5 km at geohash6', () => {
    expect(searchRing(TRUMBULL, 7).guaranteedRadiusMeters).toBeGreaterThan(50);
    expect(searchRing(TRUMBULL, 6).guaranteedRadiusMeters).toBeGreaterThan(500);
    expect(searchRing(TRUMBULL, 5).guaranteedRadiusMeters).toBeGreaterThan(3000);
  });

  it('covers a point just across a cell edge (the case a single-cell lookup misses)', () => {
    const center = encodeGeohash(TRUMBULL, 7);
    // ~40 m away in each direction: always inside the 3x3 ring even when it crosses an edge.
    for (const [dLat, dLon] of [
      [0.00036, 0],
      [-0.00036, 0],
      [0, 0.00048],
      [0, -0.00048],
    ] as const) {
      const nearby = { latitude: TRUMBULL.latitude + dLat, longitude: TRUMBULL.longitude + dLon };
      expect(searchRing(TRUMBULL, 7).cells).toContain(encodeGeohash(nearby, 7));
    }
    expect(center).toHaveLength(7);
  });
});
