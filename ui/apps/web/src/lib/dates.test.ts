import { describe, expect, test } from 'vitest';
import { daysUntil, formatCalendarDate, parseCalendarDate, relativeDays } from './dates';

describe('parseCalendarDate', () => {
  // new Date('2026-10-31') is UTC midnight - Oct 30 in Trumbull.
  test('reads YYYY-MM-DD as local midnight, never shifting the day', () => {
    const date = parseCalendarDate('2026-10-31');
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(9);
    expect(date.getDate()).toBe(31);
    expect(date.getHours()).toBe(0);
  });
});

describe('formatCalendarDate', () => {
  test('names the month instead of printing the ISO string', () => {
    const text = formatCalendarDate('2026-10-31');
    expect(text).not.toContain('2026-10-31');
    expect(text).toMatch(/31/);
    expect(text).toMatch(/2026/);
  });
});

describe('daysUntil', () => {
  const now = new Date(2026, 9, 10, 18, 47);

  test('counts whole calendar days regardless of the time of day', () => {
    expect(daysUntil('2026-10-10', now)).toBe(0);
    expect(daysUntil('2026-10-11', now)).toBe(1);
    expect(daysUntil('2026-10-31', now)).toBe(21);
  });

  test('is negative once the date has passed', () => {
    expect(daysUntil('2026-10-07', now)).toBe(-3);
  });

  test('spans a daylight-saving change without an off-by-one', () => {
    expect(daysUntil('2026-11-05', now)).toBe(26);
  });
});

describe('relativeDays', () => {
  test.each([
    [0, 'today'],
    [1, 'tomorrow'],
    [-1, 'yesterday'],
    [21, 'in 21 days'],
    [-3, '3 days ago'],
  ])('%i -> %s', (days, text) => {
    expect(relativeDays(days)).toBe(text);
  });
});
