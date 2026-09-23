import { mockScheduleRepository } from './mockScheduleRepository';

test('getShifts resolves a non-empty list', async () => {
  const shifts = await mockScheduleRepository.getShifts();
  expect(shifts.length).toBeGreaterThan(0);
});

test('claimPosition on an open position resolves CLAIMED', async () => {
  const result = await mockScheduleRepository.claimPosition('SHIFT-0511', 'DRIVER');
  expect(result).toBe('CLAIMED');
});

test('claimPosition on an already-claimed position resolves ALREADY_TAKEN', async () => {
  const result = await mockScheduleRepository.claimPosition('SHIFT-0511', 'OFFICER');
  expect(result).toBe('ALREADY_TAKEN');
});

test('markUnavailable resolves without throwing', async () => {
  await expect(
    mockScheduleRepository.markUnavailable(
      '2026-10-01T00:00:00Z',
      '2026-10-08T00:00:00Z',
      'Vacation',
    ),
  ).resolves.toBeUndefined();
});
