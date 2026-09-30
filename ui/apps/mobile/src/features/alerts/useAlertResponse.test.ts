import { rosterEta } from './useAlertResponse';

test('an At station answer read back from the roster reads "At station", not "ETA 0 min" (round 2 m2-5)', () => {
  const now = 1_000_000_000;
  expect(rosterEta(now / 1000, now)).toEqual({ minutes: 0, qualifier: 'AT_STATION' });
  expect(rosterEta(now / 1000 - 300, now)).toEqual({ minutes: 0, qualifier: 'AT_STATION' });
  expect(rosterEta(now / 1000 + 600, now)).toEqual({ minutes: 10, qualifier: null });
});
