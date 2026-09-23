import { describe, expect, it } from 'vitest';
import { coveringCells, encodeGeohash, MAX_COVERING_CELLS } from './geohash.js';

describe('coveringCells', () => {
  it('returns a deduplicated set of 5-character geohash cells covering a small viewport (AC1)', () => {
    const cells = coveringCells({ minLat: 41.24, minLng: -73.2, maxLat: 41.25, maxLng: -73.19 });
    expect(cells.length).toBeGreaterThan(0);
    expect(new Set(cells).size).toBe(cells.length);
    for (const cell of cells) {
      expect(cell).toHaveLength(5);
    }
  });

  it('covers multiple cells for a viewport that spans a geohash cell boundary (AC4)', () => {
    const cells = coveringCells({ minLat: 41.1, minLng: -73.4, maxLat: 41.3, maxLng: -73.1 });
    expect(cells.length).toBeGreaterThan(1);
  });

  it('is deterministic — the same bbox always produces the same covering set (AC4 dedupe precondition)', () => {
    const bbox = { minLat: 41.1, minLng: -73.4, maxLat: 41.3, maxLng: -73.1 };
    expect(coveringCells(bbox).sort()).toEqual(coveringCells(bbox).sort());
  });

  it('throws RangeError when minLat >= maxLat', () => {
    expect(() =>
      coveringCells({ minLat: 41.3, minLng: -73.4, maxLat: 41.1, maxLng: -73.1 }),
    ).toThrow(RangeError);
  });

  it('throws RangeError when minLng >= maxLng', () => {
    expect(() =>
      coveringCells({ minLat: 41.1, minLng: -73.1, maxLat: 41.3, maxLng: -73.4 }),
    ).toThrow(RangeError);
  });

  it('throws RangeError when the bbox would exceed the maximum covering-cell count (DoS guard, P1/P2/P7)', () => {
    expect(() => coveringCells({ minLat: -90, minLng: -180, maxLat: 90, maxLng: 180 })).toThrow(
      RangeError,
    );
    expect(() => coveringCells({ minLat: -90, minLng: -180, maxLat: 90, maxLng: 180 })).toThrow(
      new RegExp(`exceeding the maximum of ${MAX_COVERING_CELLS}`),
    );
  });

  it('includes the geohash cells for all four corners and both edge midpoints of the bbox (completeness, core-harm)', () => {
    const bbox = { minLat: 41.1, minLng: -73.4, maxLat: 41.3, maxLng: -73.1 };
    const cells = new Set(coveringCells(bbox));
    const samplePoints: [number, number][] = [
      [bbox.minLat, bbox.minLng],
      [bbox.minLat, bbox.maxLng],
      [bbox.maxLat, bbox.minLng],
      [bbox.maxLat, bbox.maxLng],
      [(bbox.minLat + bbox.maxLat) / 2, bbox.minLng],
      [(bbox.minLat + bbox.maxLat) / 2, bbox.maxLng],
      [bbox.minLat, (bbox.minLng + bbox.maxLng) / 2],
      [bbox.maxLat, (bbox.minLng + bbox.maxLng) / 2],
    ];
    for (const [lat, lng] of samplePoints) {
      expect(cells.has(encodeGeohash(lat, lng, 5))).toBe(true);
    }
  });

  it('covering set contains the geohash cell of every point on a dense grid sampled across the bbox (completeness, core-harm)', () => {
    const bbox = { minLat: 41.1, minLng: -73.4, maxLat: 41.3, maxLng: -73.1 };
    const cells = new Set(coveringCells(bbox));
    const steps = 20;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        const lat = bbox.minLat + ((bbox.maxLat - bbox.minLat) * i) / steps;
        const lng = bbox.minLng + ((bbox.maxLng - bbox.minLng) * j) / steps;
        expect(cells.has(encodeGeohash(lat, lng, 5))).toBe(true);
      }
    }
  });
});
