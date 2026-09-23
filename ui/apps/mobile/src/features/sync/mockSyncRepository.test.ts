import { mockSyncRepository } from './mockSyncRepository';

test('getStatus resolves a queue with at least one queued and one failed item', async () => {
  const status = await mockSyncRepository.getStatus();
  expect(status.items.some((item) => item.status === 'QUEUED')).toBe(true);
  expect(status.items.some((item) => item.status === 'FAILED')).toBe(true);
});

test('getStatus reports a last-sync time', async () => {
  const status = await mockSyncRepository.getStatus();
  expect(status.lastSyncAt).toEqual(expect.any(String));
});

test('retry on a failed item resolves SYNCED and removes it from the queue', async () => {
  const before = await mockSyncRepository.getStatus();
  const failed = before.items.find((item) => item.status === 'FAILED')!;

  const result = await mockSyncRepository.retry(failed.id);

  expect(result).toBe('SYNCED');
  const after = await mockSyncRepository.getStatus();
  expect(after.items.some((item) => item.id === failed.id)).toBe(false);
});
