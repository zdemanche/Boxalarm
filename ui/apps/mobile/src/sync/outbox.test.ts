import * as outbox from './outbox';
import * as store from './outboxStore';

async function clearOutbox(): Promise<void> {
  const rows = await store.all();
  await Promise.all(rows.map((row) => store.remove(row.id)));
}

beforeEach(async () => {
  await clearOutbox();
});

test('enqueue is idempotent: re-enqueueing the same id does not create a second row', async () => {
  await outbox.enqueue({
    id: 'IDEMP-1',
    kind: 'CHECKLIST_RUN',
    label: 'Truck check',
    path: 'apparatus/ENGINE-2/checks',
    body: { templateId: 'CT-01' },
  });
  await outbox.enqueue({
    id: 'IDEMP-1',
    kind: 'CHECKLIST_RUN',
    label: 'Truck check (resent)',
    path: 'apparatus/ENGINE-2/checks',
    body: { templateId: 'CT-01' },
  });

  const rows = await store.all();
  expect(rows.filter((row) => row.id === 'IDEMP-1')).toHaveLength(1);
  expect(rows.find((row) => row.id === 'IDEMP-1')?.label).toBe('Truck check');
});

test('listDrainable returns rows in queuedAt order, oldest first', async () => {
  await outbox.enqueue({
    id: 'ORDER-2',
    kind: 'DEFECT',
    label: 'second',
    path: 'apparatus/ENGINE-2/defects',
    body: {},
  });
  await outbox.enqueue({
    id: 'ORDER-1',
    kind: 'DEFECT',
    label: 'first',
    path: 'apparatus/ENGINE-2/defects',
    body: {},
  });
  // Force ORDER-1's queuedAt earlier than ORDER-2's so ordering is asserted on data, not
  // insertion order.
  await store.update('ORDER-1', { queuedAt: '2020-01-01T00:00:00.000Z' });
  await store.update('ORDER-2', { queuedAt: '2020-01-02T00:00:00.000Z' });

  const drainable = await outbox.listDrainable(Date.now());
  const ids = drainable.map((row) => row.id);
  expect(ids.indexOf('ORDER-1')).toBeLessThan(ids.indexOf('ORDER-2'));
});

test('listDrainable excludes rows that are SYNCING or not yet due for retry', async () => {
  await outbox.enqueue({
    id: 'DRAIN-SYNCING',
    kind: 'DEFECT',
    label: 'syncing',
    path: 'apparatus/ENGINE-2/defects',
    body: {},
  });
  await outbox.markSyncing('DRAIN-SYNCING');

  await outbox.enqueue({
    id: 'DRAIN-BACKOFF',
    kind: 'DEFECT',
    label: 'backing off',
    path: 'apparatus/ENGINE-2/defects',
    body: {},
  });
  await store.update('DRAIN-BACKOFF', { nextAttemptAt: Date.now() + 60_000 });

  await outbox.enqueue({
    id: 'DRAIN-DUE',
    kind: 'DEFECT',
    label: 'due now',
    path: 'apparatus/ENGINE-2/defects',
    body: {},
  });

  const drainable = await outbox.listDrainable(Date.now());
  const ids = drainable.map((row) => row.id);
  expect(ids).toContain('DRAIN-DUE');
  expect(ids).not.toContain('DRAIN-SYNCING');
  expect(ids).not.toContain('DRAIN-BACKOFF');
});

test('markFailed applies exponential backoff and never drops the item', async () => {
  await outbox.enqueue({
    id: 'BACKOFF-1',
    kind: 'DEFECT',
    label: 'flaky',
    path: 'apparatus/ENGINE-2/defects',
    body: {},
  });

  const before = Date.now();
  await outbox.markFailed('BACKOFF-1', 'first failure');
  const afterFirst = await store.find('BACKOFF-1');
  expect(afterFirst?.status).toBe('FAILED');
  expect(afterFirst?.attempts).toBe(1);
  expect(afterFirst!.nextAttemptAt).toBeGreaterThan(before);

  const firstBackoff = afterFirst!.nextAttemptAt - before;

  await outbox.markFailed('BACKOFF-1', 'second failure');
  const afterSecond = await store.find('BACKOFF-1');
  expect(afterSecond?.attempts).toBe(2);
  const secondBackoff = afterSecond!.nextAttemptAt - before;
  expect(secondBackoff).toBeGreaterThan(firstBackoff);
});

test('markSynced removes the row entirely', async () => {
  await outbox.enqueue({
    id: 'SYNCED-1',
    kind: 'CHECKLIST_RUN',
    label: 'done',
    path: 'apparatus/ENGINE-2/checks',
    body: {},
  });
  await outbox.markSynced('SYNCED-1');

  expect(await store.find('SYNCED-1')).toBeUndefined();
});

test('retry clears FAILED status and makes the row immediately due again', async () => {
  await outbox.enqueue({
    id: 'RETRY-1',
    kind: 'DEFECT',
    label: 'retry me',
    path: 'apparatus/ENGINE-2/defects',
    body: {},
  });
  await outbox.markFailed('RETRY-1', 'boom');

  await outbox.retry('RETRY-1');

  const row = await store.find('RETRY-1');
  expect(row?.status).toBe('QUEUED');
  expect(row!.nextAttemptAt).toBeLessThanOrEqual(Date.now());
});
