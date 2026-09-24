import { apiRequest } from '../lib/apiClient';
import * as store from './outboxStore';
import * as syncManager from './syncManager';

jest.mock('../lib/apiClient', () => ({ apiRequest: jest.fn() }));

const mockApiRequest = apiRequest as jest.Mock;
const tokens = { getAccessToken: jest.fn(), renewSilently: jest.fn() };

async function clearOutbox(): Promise<void> {
  const rows = await store.all();
  await Promise.all(rows.map((row) => store.remove(row.id)));
}

// enqueue*() only awaits the local write; the outbox drain it triggers is fire-and-forget
// (optimistic UI - the caller doesn't block on the network). Flushing a macrotask lets that
// drain's promise chain settle before a test asserts on its outcome.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  await clearOutbox();
  mockApiRequest.mockReset();
  syncManager.configure(tokens, 'https://api.example.com');
});

test('enqueueChecklistRun POSTs to the apparatus checks path and clears the outbox on success', async () => {
  mockApiRequest.mockResolvedValueOnce({ json: async () => ({}) });

  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-1', { templateId: 'CT-01' });
  await flush();

  expect(mockApiRequest).toHaveBeenCalledWith(
    'apparatus/ENGINE-2/checks',
    tokens,
    expect.objectContaining({ method: 'POST', apiBaseUrl: 'https://api.example.com' }),
  );
  await expect(store.find('check-1')).resolves.toBeUndefined();
});

test('a failed POST leaves the item queued (FAILED, not dropped) for the banner to show', async () => {
  mockApiRequest.mockRejectedValueOnce(new Error('Network request failed'));

  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-2', { templateId: 'CT-01' });
  await flush();

  const row = await store.find('check-2');
  expect(row?.status).toBe('FAILED');
  expect(row?.lastError).toMatch(/network request failed/i);
});

test('a defect with a photo advances CREATE -> UPLOAD_PHOTO -> DONE and uploads to the signed uploadUrl', async () => {
  mockApiRequest.mockResolvedValueOnce({
    json: async () => ({
      uploadUrl: 'https://cdn.example.com/signed',
      photoS3Key: 'dept/defect/1/x.jpg',
    }),
  });
  const fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL) => {
      if (input === 'file:///tmp/defect.jpg') {
        return { blob: async () => new Blob(['x']) } as Response;
      }
      return { ok: true, status: 200 } as Response;
    });

  await syncManager.enqueueDefect(
    'ENGINE-2',
    'defect-1',
    { description: 'x', severity: 'MINOR', photo: { filename: 'x.jpg' } },
    'file:///tmp/defect.jpg',
  );
  await flush();

  expect(fetchSpy).toHaveBeenCalledWith(
    'https://cdn.example.com/signed',
    expect.objectContaining({ method: 'PUT' }),
  );
  await expect(store.find('defect-1')).resolves.toBeUndefined();
  fetchSpy.mockRestore();
});

test('a photo upload failure retries independently and does not re-POST the already-created defect', async () => {
  mockApiRequest.mockResolvedValueOnce({
    json: async () => ({
      uploadUrl: 'https://cdn.example.com/signed',
      photoS3Key: 'dept/defect/1/x.jpg',
    }),
  });
  const fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL) => {
      if (input === 'file:///tmp/defect.jpg') {
        return { blob: async () => new Blob(['x']) } as Response;
      }
      return { ok: false, status: 500 } as Response;
    });

  await syncManager.enqueueDefect(
    'ENGINE-2',
    'defect-2',
    { description: 'x', severity: 'MINOR', photo: { filename: 'x.jpg' } },
    'file:///tmp/defect.jpg',
  );
  await flush();

  const row = await store.find('defect-2');
  expect(row?.status).toBe('FAILED');
  expect(row?.stage).toBe('UPLOAD_PHOTO');

  mockApiRequest.mockClear();
  await syncManager.retry('defect-2');
  await flush();

  expect(mockApiRequest).not.toHaveBeenCalled();
  expect((await store.find('defect-2'))?.stage).toBe('UPLOAD_PHOTO');
  fetchSpy.mockRestore();
});

test('re-enqueueing the same idempotency key while the first is still queued is a no-op', async () => {
  let resolveRequest: (value: { json: () => Promise<Record<string, never>> }) => void;
  mockApiRequest.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveRequest = resolve;
    }),
  );

  const first = syncManager.enqueueChecklistRun('ENGINE-2', 'check-dup', { templateId: 'CT-01' });
  await flush();
  // The first drain's POST is still in flight (apiRequest hasn't resolved), so the row is still
  // in the outbox - this must be a no-op, not a second queued entry.
  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-dup', { templateId: 'CT-01' });

  resolveRequest!({ json: async () => ({}) });
  await first;
  await flush();

  expect(mockApiRequest).toHaveBeenCalledTimes(1);
});
