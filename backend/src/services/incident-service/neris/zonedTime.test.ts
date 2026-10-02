import { describe, expect, it } from 'vitest';
import { isTimeZone, previousMonthOf, zonedMonth, zonedMonthBounds } from './zonedTime.js';

describe('department-local months', () => {
  it('bounds September 2026 in New York (EDT, UTC-4)', () => {
    expect(zonedMonthBounds('2026-09', 'America/New_York')).toEqual({
      from: Date.UTC(2026, 8, 1, 4) / 1000,
      to: Date.UTC(2026, 9, 1, 4) / 1000 - 1,
    });
  });

  it('crosses the November DST change and the year end correctly', () => {
    expect(zonedMonthBounds('2026-11', 'America/New_York')).toEqual({
      from: Date.UTC(2026, 10, 1, 4) / 1000,
      to: Date.UTC(2026, 11, 1, 5) / 1000 - 1,
    });
    expect(zonedMonthBounds('2026-12', 'America/New_York').to).toBe(
      Date.UTC(2027, 0, 1, 5) / 1000 - 1,
    );
  });

  it('puts a call at 20:00 on 30 September in September, not October', () => {
    const call = Date.UTC(2026, 9, 1, 0, 0); // 2026-09-30T20:00-04:00
    expect(zonedMonth(call, 'America/New_York')).toBe('2026-09');
    expect(zonedMonth(call, 'UTC')).toBe('2026-10');
  });

  it('validates zones and steps back a month', () => {
    expect(isTimeZone('America/New_York')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(previousMonthOf('2026-01')).toBe('2025-12');
    expect(previousMonthOf('2026-10')).toBe('2026-09');
  });
});
