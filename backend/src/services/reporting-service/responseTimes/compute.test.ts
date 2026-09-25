import { describe, expect, it } from 'vitest';
import { computeResponseTimeAnalytics, percentile } from './compute.js';

describe('response-time analytics', () => {
  it('computes turnout, travel, and total per unit and excludes incomplete samples per metric', () => {
    const analytics = computeResponseTimeAnalytics([
      { incidentId: 'inc-1', unitId: 'E1', dispatchedAt: 100, enRouteAt: 130, arrivedAt: 200 },
      { incidentId: 'inc-1', unitId: 'L1', dispatchedAt: 100, arrivedAt: 180 },
      { incidentId: 'inc-2', unitId: 'E2', enRouteAt: 50 },
    ]);
    expect(analytics.units[0]).toEqual({
      incidentId: 'inc-1',
      unitId: 'E1',
      turnoutSeconds: 30,
      travelSeconds: 70,
      totalSeconds: 100,
    });
    expect(analytics.units[1]).toMatchObject({
      turnoutSeconds: null,
      travelSeconds: null,
      totalSeconds: 80,
    });
    expect(analytics.turnout).toMatchObject({
      sampleCount: 1,
      excludedCount: 2,
      medianSeconds: 30,
    });
    expect(analytics.travel).toMatchObject({ sampleCount: 1, excludedCount: 2 });
    expect(analytics.total).toMatchObject({ sampleCount: 2, excludedCount: 1 });
  });

  it('interpolates the median and 90th percentile in process', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
    expect(percentile([10, 20, 30, 40], 90)).toBeCloseTo(37);
    expect(percentile([], 90)).toBeNull();
  });
});
