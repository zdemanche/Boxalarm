import { beforeAll, expect, test } from 'vitest';
import { dateInputToEpoch, epochToDateInput } from './format';

beforeAll(() => {
  process.env.TZ = 'America/New_York';
});

test('a date range covers the local day the table shows', () => {
  const oct13Evening = Date.parse('2026-10-13T21:00:00-04:00') / 1000;
  const oct12Evening = Date.parse('2026-10-12T21:00:00-04:00') / 1000;
  const from = dateInputToEpoch('2026-10-13', false);
  const to = dateInputToEpoch('2026-10-13', true);
  expect(oct13Evening >= from && oct13Evening <= to).toBe(true);
  expect(oct12Evening >= from && oct12Evening <= to).toBe(false);
});

test('the date input shows the local date', () => {
  expect(epochToDateInput(Date.parse('2026-10-13T19:30:00-04:00') / 1000)).toBe('2026-10-13');
  expect(epochToDateInput(Date.parse('2026-10-13T21:00:00-04:00') / 1000)).toBe('2026-10-13');
});
