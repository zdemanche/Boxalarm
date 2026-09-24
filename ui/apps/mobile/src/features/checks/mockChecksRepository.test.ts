import { mockChecksRepository } from './mockChecksRepository';

test('getApparatus resolves a non-empty list', async () => {
  const apparatus = await mockChecksRepository.getApparatus();
  expect(apparatus.length).toBeGreaterThan(0);
});

test('getChecklistTemplate resolves a template with at least one item', async () => {
  const [firstApparatus] = await mockChecksRepository.getApparatus();
  if (!firstApparatus) throw new Error('expected at least one apparatus from the mock repository');
  const template = await mockChecksRepository.getChecklistTemplate(firstApparatus.apparatusId);
  expect(template.items.length).toBeGreaterThan(0);
});

test('submitChecklistRun resolves without throwing (optimistic local-first write)', async () => {
  await expect(
    mockChecksRepository.submitChecklistRun({
      apparatusId: 'APP-ENGINE-2',
      templateId: 'CT-01',
      durationSeconds: 74,
      itemResults: [{ code: 'TIRES', pass: true }],
      idempotencyKey: 'check-test-1',
    }),
  ).resolves.toBeUndefined();
});

test('submitDefect resolves without throwing', async () => {
  await expect(
    mockChecksRepository.submitDefect({
      apparatusId: 'APP-ENGINE-2',
      description: 'Low tire pressure, rear axle',
      severity: 'MAJOR',
      idempotencyKey: 'defect-test-1',
    }),
  ).resolves.toBeUndefined();
});
