import { describe, expect, test } from 'vitest';
import {
  daysUntil,
  dueLabel,
  formatCalendarDate,
  formatDateTime,
  formatElapsed,
  parseCalendarDate,
  relativeDays,
  toCalendarDate,
} from './dates';

describe('parseCalendarDate', () => {
  // new Date('2026-10-31') is UTC midnight - Oct 30 in Trumbull.
  test('reads YYYY-MM-DD as local midnight, never shifting the day', () => {
    const date = parseCalendarDate('2026-10-31');
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(9);
    expect(date.getDate()).toBe(31);
    expect(date.getHours()).toBe(0);
  });

  test('reads a full ISO timestamp as the local day that instant falls on', () => {
    const instant = new Date(2026, 9, 7, 23, 30);
    const date = parseCalendarDate(instant.toISOString());
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(9);
    expect(date.getDate()).toBe(7);
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

  test('formats a full ISO timestamp as a date, not "Invalid Date"', () => {
    const text = formatCalendarDate(new Date(2026, 9, 7, 12).toISOString());
    expect(text).toMatch(/7/);
    expect(text).toMatch(/2026/);
    expect(text).not.toMatch(/Invalid/);
  });
});

describe('toCalendarDate', () => {
  test('is the local calendar day of an epoch value, round-tripping through daysUntil', () => {
    const lateEvening = new Date(2026, 9, 10, 23, 59).getTime();
    expect(toCalendarDate(lateEvening)).toBe('2026-10-10');
    expect(daysUntil(toCalendarDate(lateEvening), new Date(2026, 9, 10, 8))).toBe(0);
  });
});

describe('formatDateTime', () => {
  const evening = new Date(2026, 9, 10, 19, 0, 42).getTime();

  test('shows the date and the time to the minute, never the seconds', () => {
    const text = formatDateTime(evening);
    expect(text).toMatch(/2026/);
    expect(text).toMatch(/10/);
    expect(text).toMatch(/7:00|19:00/);
    expect(text).not.toMatch(/:42/);
    expect(text).not.toMatch(/\d:\d{2}:\d{2}/);
  });

  test('renders a dash, not "Invalid Date", for an unreadable value', () => {
    expect(formatDateTime(Number.NaN)).toBe('—');
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

describe('dueLabel', () => {
  test.each([
    [-35, 'Overdue · 35 days'],
    [-1, 'Overdue · 1 day'],
    [0, 'Due today'],
    [1, 'Due tomorrow'],
    [5, 'Due in 5 days'],
  ])('%i -> %s', (days, text) => {
    expect(dueLabel(days)).toBe(text);
  });
});

describe('formatElapsed', () => {
  test.each([
    [48 * 3600, '2 d 0 h'],
    [50 * 3600 + 59 * 60, '2 d 2 h'],
    [5 * 3600, '5 h'],
    [3900, '1 h 5 min'],
    [45 * 60 + 30, '45 min'],
    [0, '0 min'],
  ])('%i s -> %s', (seconds, text) => {
    expect(formatElapsed(seconds)).toBe(text);
  });

  test('renders a dash when the span could not be measured', () => {
    expect(formatElapsed(null)).toBe('—');
    expect(formatElapsed(Number.NaN)).toBe('—');
    expect(formatElapsed(-60)).toBe('—');
  });
});
