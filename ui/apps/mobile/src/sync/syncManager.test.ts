import NetInfo from '@react-native-community/netinfo';
import { ApiError, apiRequest } from '../lib/apiClient';
import * as outbox from './outbox';
import * as store from './outboxStore';
import * as syncManager from './syncManager';
import { signedPhotoContentType } from './syncManager';

jest.mock('../lib/apiClient', () => ({
  ...jest.requireActual('../lib/apiClient'),
  apiRequest: jest.fn(),
}));

const mockApiRequest = apiRequest as jest.Mock;
function problem(status: number, title: string): ApiError {
  return new ApiError({ type: 'about:blank', title, status, traceId: 't' });
}

const tokens = { getAccessToken: jest.fn(), renewSilently: jest.fn(), memberId: 'm-test' };

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
  // configure() kicks off its own drain; let it settle so it can't race the test's first drain.
  await flush();
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

test('the first drain after app start recovers a row left SYNCING by a killed process', async () => {
  await jest.isolateModulesAsync(async () => {
    // jest.requireActual/requireMock resolve through the isolated registry, so these are fresh
    // module instances (fresh fake DB, never-drained syncManager) - i.e. a new app process.
    const freshStore = jest.requireActual<typeof store>('./outboxStore');
    const freshOutbox = jest.requireActual<typeof import('./outbox')>('./outbox');
    const freshApi = jest.requireMock<{ apiRequest: jest.Mock }>('../lib/apiClient');
    freshApi.apiRequest.mockResolvedValue({ json: async () => ({}) });

    await freshOutbox.enqueue({
      ownerMemberId: 'm-test',
      ownerDeptId: null,
      id: 'orphan-1',
      kind: 'CHECKLIST_RUN',
      label: 'Truck check — ENGINE-2',
      path: 'apparatus/ENGINE-2/checks',
      body: {},
    });
    await freshOutbox.markSyncing('orphan-1');

    const freshManager = jest.requireActual<typeof syncManager>('./syncManager');
    freshManager.configure(tokens, 'https://api.example.com');
    await freshManager.drain();
    await flush();

    expect(freshApi.apiRequest).toHaveBeenCalledWith(
      'apparatus/ENGINE-2/checks',
      tokens,
      expect.anything(),
    );
    await expect(freshStore.find('orphan-1')).resolves.toBeUndefined();
  });
});

test('a 4xx validation rejection is terminal (REJECTED): kept for the user, never auto-retried', async () => {
  mockApiRequest.mockRejectedValueOnce(problem(422, 'Checklist template is retired'));

  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-422', { templateId: 'CT-OLD' });
  await flush();

  const row = await store.find('check-422');
  expect(row?.status).toBe('REJECTED');
  expect(row?.lastError).toMatch(/template is retired/i);

  mockApiRequest.mockClear();
  await store.update('check-422', { nextAttemptAt: 0 });
  await syncManager.drain();
  expect(mockApiRequest).not.toHaveBeenCalled();
});

test.each([408, 429, 500, 503])('HTTP %i stays a transient FAILED with backoff', async (status) => {
  mockApiRequest.mockRejectedValueOnce(problem(status, 'try later'));

  await syncManager.enqueueChecklistRun('ENGINE-2', `check-${status}`, {});
  await flush();

  expect((await store.find(`check-${status}`))?.status).toBe('FAILED');
});

test('a REJECTED item can be manually retried or discarded', async () => {
  mockApiRequest.mockRejectedValueOnce(problem(400, 'Bad payload'));
  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-400', {});
  await flush();
  expect((await store.find('check-400'))?.status).toBe('REJECTED');

  mockApiRequest.mockResolvedValueOnce({ json: async () => ({}) });
  await syncManager.retry('check-400');
  await flush();
  await expect(store.find('check-400')).resolves.toBeUndefined();

  mockApiRequest.mockRejectedValueOnce(problem(400, 'Bad payload'));
  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-discard', {});
  await flush();
  await syncManager.discard('check-discard');
  await expect(store.find('check-discard')).resolves.toBeUndefined();
});

const mockAddEventListener = NetInfo.addEventListener as jest.Mock;

test('configuring tokens drains items that were queued while signed out', async () => {
  syncManager.configure(null, null);
  // No configured session: the owner comes from the stored session (R3-C1).
  syncManager.setOwnerResolver(async () => ({ memberId: 'm-test', deptId: null }));
  mockApiRequest.mockResolvedValue({ json: async () => ({}) });

  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-signed-out', {});
  await flush();
  expect(mockApiRequest).not.toHaveBeenCalled();

  syncManager.configure(tokens, 'https://api.example.com');
  await flush();

  expect(mockApiRequest).toHaveBeenCalledTimes(1);
  await expect(store.find('check-signed-out')).resolves.toBeUndefined();
  syncManager.setOwnerResolver(null);
});

test('the reconnect listener is registered once while configured and removed on sign-out', async () => {
  syncManager.configure(null, null);
  mockAddEventListener.mockClear();
  const unsubscribe = jest.fn();
  mockAddEventListener.mockReturnValue(unsubscribe);

  syncManager.configure(tokens, 'https://api.example.com');
  syncManager.configure(tokens, 'https://api.example.com');
  await flush();
  expect(mockAddEventListener).toHaveBeenCalledTimes(1);

  syncManager.configure(null, null);
  expect(unsubscribe).toHaveBeenCalledTimes(1);

  syncManager.configure(tokens, 'https://api.example.com');
  await flush();
  expect(mockAddEventListener).toHaveBeenCalledTimes(2);
});

test('regaining connectivity drains the outbox', async () => {
  syncManager.configure(null, null);
  mockAddEventListener.mockClear();
  syncManager.configure(tokens, 'https://api.example.com');
  await flush();
  const onChange = mockAddEventListener.mock.calls[0][0] as (state: {
    isConnected: boolean;
  }) => void;

  mockApiRequest.mockRejectedValueOnce(new Error('Network request failed'));
  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-reconnect', {});
  await flush();
  await store.update('check-reconnect', { nextAttemptAt: 0 });

  mockApiRequest.mockResolvedValueOnce({ json: async () => ({}) });
  onChange({ isConnected: true });
  await flush();

  await expect(store.find('check-reconnect')).resolves.toBeUndefined();
});

test('an item enqueued while a drain is already running is still sent by that drain cycle', async () => {
  let resolveFirst: (value: { json: () => Promise<Record<string, never>> }) => void = () => {};
  mockApiRequest
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    )
    .mockResolvedValue({ json: async () => ({}) });

  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-first', {});
  await flush();
  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-during', {});
  resolveFirst({ json: async () => ({}) });
  await flush();
  await flush();

  await expect(store.find('check-first')).resolves.toBeUndefined();
  await expect(store.find('check-during')).resolves.toBeUndefined();
});

async function enqueuePhotoDefect(id: string, uploadUrl: string, putStatus: number) {
  mockApiRequest.mockResolvedValueOnce({
    json: async () => ({ uploadUrl, photoS3Key: 'dept/defect/1/x.jpg' }),
  });
  const fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL) => {
      if (input === 'file:///tmp/defect.jpg') {
        return { blob: async () => new Blob(['x']) } as Response;
      }
      return { ok: putStatus < 400, status: putStatus } as Response;
    });
  await syncManager.enqueueDefect(
    'ENGINE-2',
    id,
    { description: 'x', severity: 'MINOR', photo: { filename: 'x.jpg' } },
    'file:///tmp/defect.jpg',
  );
  await flush();
  return fetchSpy;
}

// The defect was reported, then the link expired before its photo went up. It used to be
// REJECTED as "reported without its photo"; the defect POST's replay now re-signs the link.
test('an already-expired defect upload link is not PUT; an idempotent replay re-signs it', async () => {
  // Signed 2023-11-14T22:13:20Z for 600 s: long past.
  const expiredUrl =
    'https://assets.s3.us-east-1.amazonaws.com/dept/defect/1/x.jpg?X-Amz-Date=20231114T221320Z&X-Amz-Expires=600&X-Amz-Signature=s';
  const freshUrl = `https://assets.s3.us-east-1.amazonaws.com/dept/defect/1/x.jpg?X-Amz-Date=${amzDate(new Date())}&X-Amz-Expires=600&X-Amz-Signature=s`;
  mockApiRequest.mockResolvedValueOnce({ json: async () => ({ uploadUrl: expiredUrl }) });
  mockApiRequest.mockResolvedValueOnce({
    json: async () => ({ uploadUrl: freshUrl, photoS3Key: 'dept/defect/1/x.jpg' }),
  });
  const fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL) =>
      input === 'file:///tmp/defect.jpg'
        ? ({ blob: async () => new Blob(['x']) } as Response)
        : ({ ok: true, status: 200 } as Response),
    );
  await syncManager.enqueueDefect(
    'ENGINE-2',
    'defect-expired',
    {
      description: 'x',
      severity: 'MINOR',
      idempotencyKey: 'defect-expired',
      photo: { filename: 'x.jpg' },
    },
    'file:///tmp/defect.jpg',
  );
  await flush();

  expect(mockApiRequest).toHaveBeenCalledTimes(2);
  expect(mockApiRequest.mock.calls[1][2].body).toContain('"idempotencyKey":"defect-expired"');
  expect(fetchSpy).not.toHaveBeenCalledWith(expiredUrl, expect.anything());
  expect(fetchSpy).toHaveBeenCalledWith(freshUrl, expect.objectContaining({ method: 'PUT' }));
  await expect(store.find('defect-expired')).resolves.toBeUndefined();
  fetchSpy.mockRestore();
});

test('a 403 from the defect upload URL is REJECTED and rewound, so Retry fetches a new link', async () => {
  const fetchSpy = await enqueuePhotoDefect(
    'defect-403',
    `https://assets.s3.us-east-1.amazonaws.com/dept/defect/1/x.jpg?X-Amz-Date=${amzDate(new Date())}&X-Amz-Expires=600&X-Amz-Signature=s`,
    403,
  );

  const row = await store.find('defect-403');
  expect(row?.status).toBe('REJECTED');
  expect(row?.stage).toBe('CREATE');
  expect(row?.lastError).toMatch(/retry to request a new upload link/i);
  fetchSpy.mockRestore();
});

function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

test('reads the expiry of an S3 presigned URL from X-Amz-Date + X-Amz-Expires', () => {
  expect(
    syncManager.signedUrlExpiresAtMs(
      'https://b.s3.amazonaws.com/k?X-Amz-Date=20260927T120000Z&X-Amz-Expires=600&X-Amz-Signature=s',
    ),
  ).toBe(Date.UTC(2026, 8, 27, 12, 10, 0));
  expect(syncManager.signedUrlExpiresAtMs('https://b.s3.amazonaws.com/k')).toBeNull();
});

describe('field capture', () => {
  const PHOTO = 'file:///tmp/capture.jpg';
  const FILENAME = 'fc-1-capture.jpg';
  const KEY = `DEPT-1/INSPECTION_RECORD/insp-1/${FILENAME}`;

  function signedUrl(signedAt: Date): string {
    return `https://assets.s3.us-east-1.amazonaws.com/${KEY}?X-Amz-Date=${amzDate(signedAt)}&X-Amz-Expires=600&X-Amz-Signature=s`;
  }

  function captureResponse(uploadUrl: string, outcome: 'created' | 'duplicate' = 'created') {
    return {
      json: async () => ({
        idempotencyOutcome: outcome,
        inspection: { occupancyId: 'occ-1', inspectionId: 'insp-1', photoS3Keys: [KEY] },
        photoUploadUrls: [{ filename: FILENAME, uploadUrl }],
      }),
    };
  }

  function mockUpload(putStatus: number) {
    return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      if (input === PHOTO) return { blob: async () => new Blob(['x']) } as Response;
      return { ok: putStatus < 400, status: putStatus } as Response;
    });
  }

  const body = {
    occupancyId: 'occ-1',
    inspectionId: 'insp-1',
    idempotencyKey: 'fc-1',
    photoFilenames: [FILENAME],
    violations: [],
  };

  test('POSTs to inspections/field-capture, then PUTs the photo to its presigned S3 URL', async () => {
    const url = signedUrl(new Date());
    mockApiRequest.mockResolvedValueOnce(captureResponse(url));
    const fetchSpy = mockUpload(200);

    await syncManager.enqueueFieldCapture('fc-1', 'occ-1', body, PHOTO);
    await flush();

    expect(mockApiRequest).toHaveBeenCalledWith(
      'inspections/field-capture',
      tokens,
      expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'PUT' }));
    await expect(store.find('fc-1')).resolves.toBeUndefined();
    fetchSpy.mockRestore();
  });

  test('queued while offline, it waits in the outbox and drains once the network returns', async () => {
    const mockFetchNetInfo = NetInfo.fetch as jest.Mock;
    mockFetchNetInfo.mockResolvedValueOnce({ isConnected: false });

    await syncManager.enqueueFieldCapture('fc-1', 'occ-1', { ...body, photoFilenames: [] });
    await flush();
    expect(mockApiRequest).not.toHaveBeenCalled();
    expect((await store.find('fc-1'))?.status).toBe('QUEUED');

    mockApiRequest.mockResolvedValueOnce({ json: async () => ({ photoUploadUrls: [] }) });
    await syncManager.drain();
    await expect(store.find('fc-1')).resolves.toBeUndefined();
  });

  test('an upload link that expired while queued is re-signed by an idempotent replay, not lost', async () => {
    // The capture was created and its photo link issued, then the phone lost signal (or the app
    // was killed) for longer than the link's 10-minute life.
    const stale = signedUrl(new Date(Date.now() - 20 * 60_000));
    const fresh = signedUrl(new Date());
    const mockFetchNetInfo = NetInfo.fetch as jest.Mock;
    mockFetchNetInfo.mockResolvedValueOnce({ isConnected: false });
    await syncManager.enqueueFieldCapture('fc-1', 'occ-1', body, PHOTO);
    await flush();
    await store.update('fc-1', { stage: 'UPLOAD_PHOTO', photoUploadUrl: stale });

    const fetchSpy = mockUpload(200);
    mockApiRequest.mockResolvedValueOnce(captureResponse(fresh, 'duplicate'));
    await syncManager.drain();

    expect(mockApiRequest).toHaveBeenCalledTimes(1);
    expect(mockApiRequest.mock.calls[0][2].body).toContain('"idempotencyKey":"fc-1"');
    expect(fetchSpy).not.toHaveBeenCalledWith(stale, expect.anything());
    expect(fetchSpy).toHaveBeenCalledWith(fresh, expect.objectContaining({ method: 'PUT' }));
    await expect(store.find('fc-1')).resolves.toBeUndefined();
    fetchSpy.mockRestore();
  });

  test('a 403 on the photo PUT is REJECTED and rewound so Retry fetches a new link', async () => {
    mockApiRequest.mockResolvedValueOnce(captureResponse(signedUrl(new Date())));
    const fetchSpy = mockUpload(403);

    await syncManager.enqueueFieldCapture('fc-1', 'occ-1', body, PHOTO);
    await flush();

    const row = await store.find('fc-1');
    expect(row?.status).toBe('REJECTED');
    expect(row?.stage).toBe('CREATE');
    expect(row?.lastError).toMatch(/retry to request a new upload link/i);
    fetchSpy.mockRestore();

    const okSpy = mockUpload(200);
    mockApiRequest.mockResolvedValueOnce(captureResponse(signedUrl(new Date()), 'duplicate'));
    await syncManager.retry('fc-1');
    await flush();
    await expect(store.find('fc-1')).resolves.toBeUndefined();
    okSpy.mockRestore();
  });

  test('a 404 for an unknown inspection is REJECTED with the server reason, never auto-retried', async () => {
    mockApiRequest.mockRejectedValueOnce(
      new ApiError({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Inspection insp-9 was not found',
        traceId: 't',
      }),
    );

    await syncManager.enqueueFieldCapture('fc-1', 'occ-1', body, PHOTO);
    await flush();

    const row = await store.find('fc-1');
    expect(row?.status).toBe('REJECTED');
    expect(row?.lastError).toBe('Inspection insp-9 was not found');
  });

  test('a 503 is a transient FAILED that keeps its stable idempotency key for the retry', async () => {
    mockApiRequest.mockRejectedValueOnce(problem(503, 'Service Unavailable'));

    await syncManager.enqueueFieldCapture('fc-1', 'occ-1', body);
    await flush();

    const row = await store.find('fc-1');
    expect(row?.status).toBe('FAILED');
    expect(JSON.parse(row!.body).idempotencyKey).toBe('fc-1');
  });
});

describe('attendance', () => {
  const entry = { activityType: 'DRILL', refId: null, occurredAt: 1_790_000_000, hours: 1 };

  test('POSTs to personnel/attendance and clears the outbox on success', async () => {
    mockApiRequest.mockResolvedValueOnce({
      json: async () => ({ ...entry, losapPointsAwarded: 1 }),
    });

    await syncManager.enqueueAttendance('attendance-1790000000', 'Attendance — Drill', entry);
    await flush();

    expect(mockApiRequest).toHaveBeenCalledWith(
      'personnel/attendance',
      tokens,
      expect.objectContaining({ method: 'POST', body: JSON.stringify(entry) }),
    );
    await expect(store.find('attendance-1790000000')).resolves.toBeUndefined();
  });

  test('queued offline, it is kept and drained when connectivity returns', async () => {
    syncManager.configure(null, null);
    mockAddEventListener.mockClear();
    syncManager.configure(tokens, 'https://api.example.com');
    await flush();
    const onChange = mockAddEventListener.mock.calls[0][0] as (state: {
      isConnected: boolean;
    }) => void;
    (NetInfo.fetch as jest.Mock).mockResolvedValueOnce({ isConnected: false });

    await syncManager.enqueueAttendance('attendance-1790000000', 'Attendance — Drill', entry);
    await flush();
    expect(mockApiRequest).not.toHaveBeenCalled();
    expect((await store.find('attendance-1790000000'))?.status).toBe('QUEUED');

    mockApiRequest.mockResolvedValueOnce({ json: async () => entry });
    onChange({ isConnected: true });
    await flush();

    await expect(store.find('attendance-1790000000')).resolves.toBeUndefined();
  });

  test('a 409 on replay means the first attempt landed: delivered, not rejected', async () => {
    mockApiRequest.mockRejectedValueOnce(problem(409, 'Conflict'));

    await syncManager.enqueueAttendance('attendance-1790000000', 'Attendance — Drill', entry);
    await flush();

    await expect(store.find('attendance-1790000000')).resolves.toBeUndefined();
    expect(syncManager.hasSynced('attendance-1790000000')).toBe(true);
  });

  test('a mark-off is POSTed to the member availability path', async () => {
    const markOff = { startAt: 1790000000, endAt: 1790086400, reason: 'Travel' };
    mockApiRequest.mockResolvedValueOnce({ json: async () => ({}) });

    await syncManager.enqueueAvailability('availability-a', 'm-test', 'Mark unavailable', markOff);
    await flush();

    expect(mockApiRequest).toHaveBeenCalledWith(
      'personnel/members/m-test/availability',
      tokens,
      expect.objectContaining({ method: 'POST', body: JSON.stringify(markOff) }),
    );
    expect(syncManager.hasSynced('availability-a')).toBe(true);
  });

  // Review M1: a 409 means another window already holds this start - never "delivered".
  test('a 409 on a mark-off is REJECTED with a plain reason, not counted as delivered', async () => {
    mockApiRequest.mockRejectedValueOnce(problem(409, 'Conflict'));

    await syncManager.enqueueAvailability('availability-b', 'm-test', 'Mark unavailable', {
      startAt: 1790000000,
      endAt: 1790020000,
    });
    await flush();

    const row = await store.find('availability-b');
    expect(row?.status).toBe('REJECTED');
    expect(row?.lastError).toBe(syncManager.AVAILABILITY_CONFLICT);
    expect(syncManager.hasSynced('availability-b')).toBe(false);
  });

  // R2-M1 (a): the first POST landed but its response was lost; the resend gets 409.
  test('a 409 on a resend after a lost response says it may already be in effect', async () => {
    mockApiRequest
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockRejectedValueOnce(problem(409, 'Conflict'));

    await syncManager.enqueueAvailability('availability-lost', 'm-test', 'Mark unavailable', {
      startAt: 1790000000,
      endAt: 1790020000,
    });
    await flush();
    expect((await store.find('availability-lost'))?.status).toBe('FAILED');

    await syncManager.retry('availability-lost');
    await flush();

    const row = await store.find('availability-lost');
    expect(row?.status).toBe('REJECTED');
    expect(row?.lastError).toBe(syncManager.AVAILABILITY_MAY_BE_IN_EFFECT);
  });

  // R2-M1 (b): an older mark-off that was already sent may have landed; it is kept, not dropped.
  test('a correction keeps an older mark-off that was already attempted, and says both may stand', async () => {
    mockApiRequest.mockRejectedValueOnce(new TypeError('Network request failed'));
    await syncManager.enqueueAvailability('availability-sent', 'm-test', 'Mark unavailable', {
      startAt: 1790000000,
      endAt: 1790604800,
    });
    await flush();
    expect((await store.find('availability-sent'))?.attempts).toBe(1);

    syncManager.configure(null, null);
    const result = await syncManager.enqueueAvailability(
      'availability-fixed',
      'm-test',
      'Mark unavailable',
      { startAt: 1790000020, endAt: 1790030000 },
    );
    syncManager.configure(tokens, 'https://api.example.com');

    expect(result).toEqual({ replaced: 0, mayStand: 1 });
    expect(await store.find('availability-sent')).toBeDefined();
  });

  // R2-M1 send race: replace and claim-for-send are conditional, so exactly one of them wins.
  test('a row the drain has claimed for sending cannot be discarded, and vice versa', async () => {
    syncManager.configure(null, null);
    await outbox.enqueue({
      ownerMemberId: 'm-test',
      ownerDeptId: null,
      id: 'race-1',
      kind: 'AVAILABILITY',
      label: 'x',
      path: 'personnel/members/m-test/availability',
      body: {},
    });
    await outbox.enqueue({
      ownerMemberId: 'm-test',
      ownerDeptId: null,
      id: 'race-2',
      kind: 'AVAILABILITY',
      label: 'x',
      path: 'personnel/members/m-test/availability',
      body: {},
    });

    expect(await outbox.claimForSync('race-1')).toBe(true);
    expect(await outbox.discardIfUnattempted('race-1')).toBe(false);
    expect(await outbox.discardIfUnattempted('race-2')).toBe(true);
    expect(await outbox.claimForSync('race-2')).toBe(false);
    syncManager.configure(tokens, 'https://api.example.com');
  });

  test('a corrected mark-off replaces an older one that has not been sent yet', async () => {
    syncManager.configure(null, null);
    const week = { startAt: 1790000000, endAt: 1790604800 };
    const tonight = { startAt: 1790000010, endAt: 1790030000 };

    await syncManager.enqueueAvailability('availability-week', 'm-test', 'Mark unavailable', week);
    const { replaced } = await syncManager.enqueueAvailability(
      'availability-tonight',
      'm-test',
      'Mark unavailable',
      tonight,
    );

    expect(replaced).toBe(1);
    await expect(store.find('availability-week')).resolves.toBeUndefined();
    expect((await store.find('availability-tonight'))?.body).toBe(JSON.stringify(tonight));
    syncManager.configure(tokens, 'https://api.example.com');
  });

  test('a mark-off without a member id is refused, never sent to a blank path', async () => {
    await expect(
      syncManager.enqueueAvailability('availability-x', '', 'Mark unavailable', {}),
    ).rejects.toThrow();
  });

  test('a 409 is still a rejection for kinds that carry their own idempotency key', async () => {
    mockApiRequest.mockRejectedValueOnce(problem(409, 'Conflict'));

    await syncManager.enqueueChecklistRun('ENGINE-2', 'check-409', {});
    await flush();

    expect((await store.find('check-409'))?.status).toBe('REJECTED');
  });

  test('a 400 validation failure is REJECTED with the reason and waits for the user', async () => {
    mockApiRequest.mockRejectedValueOnce(
      new ApiError({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'The request body must supply activityType',
        traceId: 't',
      }),
    );

    await syncManager.enqueueAttendance('attendance-1790000000', 'Attendance — Drill', entry);
    await flush();

    const row = await store.find('attendance-1790000000');
    expect(row?.status).toBe('REJECTED');
    expect(row?.lastError).toMatch(/must supply activityType/);
  });
});

// Review minor 11: the upload URL is signed over Content-Type, so the PUT must send the type
// the server derived from the object key - a mismatch is a 403 the outbox reads as expiry.
describe('signedPhotoContentType', () => {
  test('uses the signed key extension, not the local file URI', () => {
    expect(
      signedPhotoContentType(
        'https://bucket.s3.us-east-1.amazonaws.com/NICHOLS/defect/D-1/photo.heic?X-Amz-Expires=600',
        'file:///tmp/converted.jpg',
      ),
    ).toBe('image/heic');
  });

  test('matches the server mapping case-insensitively', () => {
    expect(
      signedPhotoContentType('https://b.s3.amazonaws.com/N/INSPECTION_RECORD/I/IMG.JPG?x=1', ''),
    ).toBe('image/jpeg');
  });

  test('falls back to the local URI, then image/jpeg', () => {
    expect(signedPhotoContentType('not a url', 'file:///a/b.png')).toBe('image/png');
    expect(signedPhotoContentType('not a url', 'file:///a/b')).toBe('image/jpeg');
  });
});

describe('alert responses (RESPONSE)', () => {
  test('a response POSTs to the dispatch responses path and leaves the outbox on success', async () => {
    mockApiRequest.mockResolvedValueOnce({ json: async () => ({}) });

    await syncManager.enqueueResponse('response-1', 'D/1', 'Your response — Responding', {
      ackStatus: 'RESPONDING',
      eta: 123,
      assignedApparatusId: null,
    });
    await flush();

    expect(mockApiRequest).toHaveBeenCalledWith(
      'alerting/dispatches/D%2F1/responses',
      tokens,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(syncManager.hasSynced('response-1')).toBe(true);
  });

  test('a changed answer drops the older one still waiting, so it can never land after the new one', async () => {
    mockApiRequest.mockRejectedValue(new Error('Network request failed'));

    await syncManager.enqueueResponse('response-a', 'D1', 'a', { ackStatus: 'RESPONDING' });
    await flush();
    expect((await store.find('response-a'))?.status).toBe('FAILED');

    await syncManager.enqueueResponse('response-b', 'D1', 'b', { ackStatus: 'NOT_RESPONDING' });
    await flush();

    await expect(store.find('response-a')).resolves.toBeUndefined();
    expect((await store.find('response-b'))?.status).toBe('FAILED');
    expect(syncManager.hasSynced('response-a')).toBe(false);
  });

  test('a 409 on an answer means the roster did not take it: kept, terminal, and named as such', async () => {
    mockApiRequest.mockRejectedValueOnce(problem(409, 'Conflict'));

    await syncManager.enqueueResponse('response-409', 'D5', 'x', { ackStatus: 'RESPONDING' });
    await flush();

    const row = await store.find('response-409');
    expect(row?.status).toBe('REJECTED');
    expect(row?.lastError).toBe(syncManager.RESPONSE_NOT_RECORDED);
  });

  test('409 code SUPERSEDED is recorded as "a newer answer is on the roster", not as not-recorded', async () => {
    mockApiRequest.mockRejectedValueOnce(
      new ApiError({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        traceId: 't',
        code: 'SUPERSEDED',
      } as never),
    );

    await syncManager.enqueueResponse('response-sup', 'D6', 'x', { ackStatus: 'NOT_RESPONDING' });
    await flush();

    expect(syncManager.hasSynced('response-sup')).toBe(false);
    const row = await store.find('response-sup');
    expect(row?.status).toBe('REJECTED');
    expect(row?.lastError).toBe(syncManager.RESPONSE_SUPERSEDED);
  });

  test('409 with any other code (ANSWER_ID_REUSED) is "not recorded"', async () => {
    mockApiRequest.mockRejectedValueOnce(
      new ApiError({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        traceId: 't',
        code: 'ANSWER_ID_REUSED',
      } as never),
    );

    await syncManager.enqueueResponse('response-reused', 'D7', 'x', { ackStatus: 'RESPONDING' });
    await flush();

    expect((await store.find('response-reused'))?.lastError).toBe(
      syncManager.RESPONSE_NOT_RECORDED,
    );
  });

  test('a 401 that survives renewal is retried but recorded as a sign-in problem, not a network one', async () => {
    mockApiRequest.mockRejectedValueOnce(problem(401, 'Unauthorized'));

    await syncManager.enqueueResponse('response-401', 'D8', 'x', { ackStatus: 'RESPONDING' });
    await flush();

    const row = await store.find('response-401');
    expect(row?.status).toBe('FAILED');
    expect(row?.lastError).toBe(syncManager.SIGN_IN_REJECTED);
  });

  describe('an answer with no ETA (runtime fallback for a server that still requires one)', () => {
    const noEta = {
      ackStatus: 'RESPONDING',
      eta: null,
      etaSource: 'NOT_GIVEN',
      answeredAtMs: 1_000_000,
    };

    test('a server that accepts eta null gets exactly one POST with eta null', async () => {
      mockApiRequest.mockResolvedValue({ json: async () => ({}) });

      await syncManager.enqueueResponse('response-null-ok', 'D10', 'x', noEta);
      await flush();

      expect(mockApiRequest).toHaveBeenCalledTimes(1);
      expect(JSON.parse(mockApiRequest.mock.calls[0]![2].body as string).eta).toBeNull();
      expect(syncManager.hasSynced('response-null-ok')).toBe(true);
    });

    test('a 400 naming eta is re-sent once with the placeholder, flagged NOT_GIVEN, and delivered', async () => {
      mockApiRequest
        .mockRejectedValueOnce(
          new ApiError({
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail: 'eta is required and must be a positive integer for this ackStatus',
            traceId: 't',
          }),
        )
        .mockResolvedValueOnce({ json: async () => ({}) });

      await syncManager.enqueueResponse('response-null-400', 'D11', 'x', noEta);
      await flush();

      expect(mockApiRequest).toHaveBeenCalledTimes(2);
      const retried = JSON.parse(mockApiRequest.mock.calls[1]![2].body as string);
      expect(retried).toMatchObject({
        eta: 1_000 + syncManager.RESPONSE_PLACEHOLDER_ETA_MINUTES * 60,
        etaSource: 'NOT_GIVEN',
      });
      expect(syncManager.hasSynced('response-null-400')).toBe(true);
    });

    test('a 400 about something else is refused without a retry', async () => {
      mockApiRequest.mockRejectedValueOnce(problem(400, 'ackStatus is required'));

      await syncManager.enqueueResponse('response-400-other', 'D12', 'x', noEta);
      await flush();

      expect(mockApiRequest).toHaveBeenCalledTimes(1);
      expect((await store.find('response-400-other'))?.status).toBe('REJECTED');
    });

    test('the fallback is tried once: a second 400 is refused, and a later retry sends the placeholder', async () => {
      const etaProblem = new ApiError({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'eta is required',
        traceId: 't',
      });
      mockApiRequest.mockRejectedValueOnce(etaProblem).mockRejectedValueOnce(etaProblem);

      await syncManager.enqueueResponse('response-null-twice', 'D13', 'x', noEta);
      await flush();

      expect(mockApiRequest).toHaveBeenCalledTimes(2);
      const row = await store.find('response-null-twice');
      expect(row?.status).toBe('REJECTED');
      expect(JSON.parse(row!.body).eta).toBe(1_000 + 600);
    });
  });

  test('answers to different calls do not supersede each other', async () => {
    mockApiRequest.mockRejectedValue(new Error('Network request failed'));

    await syncManager.enqueueResponse('response-x', 'D1', 'x', { ackStatus: 'RESPONDING' });
    await syncManager.enqueueResponse('response-y', 'D2', 'y', { ackStatus: 'RESPONDING' });
    await flush();

    expect(await store.find('response-x')).toBeDefined();
    expect(await store.find('response-y')).toBeDefined();
  });

  test('an older answer that was mid-send when superseded is dropped at the next drain instead of retried', async () => {
    await store.insert({
      id: 'response-old',
      kind: 'RESPONSE',
      label: 'old',
      method: 'POST',
      path: 'alerting/dispatches/D3/responses',
      body: '{}',
      stage: 'CREATE',
      photoLocalUri: null,
      photoS3Key: null,
      photoUploadUrl: null,
      status: 'FAILED',
      attempts: 1,
      lastError: 'x',
      queuedAt: '2026-01-01T00:00:00.000Z',
      nextAttemptAt: 0,
      syncedAt: null,
      ownerMemberId: 'm-test',
      ownerDeptId: null,
    });
    await store.insert({
      id: 'response-new',
      kind: 'RESPONSE',
      label: 'new',
      method: 'POST',
      path: 'alerting/dispatches/D3/responses',
      body: '{"ackStatus":"NOT_RESPONDING"}',
      stage: 'CREATE',
      photoLocalUri: null,
      photoS3Key: null,
      photoUploadUrl: null,
      status: 'QUEUED',
      attempts: 0,
      lastError: null,
      queuedAt: '2026-01-01T00:00:05.000Z',
      nextAttemptAt: 0,
      syncedAt: null,
      ownerMemberId: 'm-test',
      ownerDeptId: null,
    });
    mockApiRequest.mockResolvedValue({ json: async () => ({}) });

    await syncManager.drain();

    expect(mockApiRequest).toHaveBeenCalledTimes(1);
    expect(mockApiRequest.mock.calls[0]![2].body).toBe('{"ackStatus":"NOT_RESPONDING"}');
    await expect(store.find('response-old')).resolves.toBeUndefined();
  });
});

// R2-M3: a station phone shared by members A and B.
describe('queued work belongs to the member who queued it', () => {
  const memberA = { ...tokens, memberId: 'member-a', deptId: 'nichols' };
  const memberB = { ...tokens, memberId: 'member-b', deptId: 'nichols' };
  const entry = { activityType: 'DRILL', refId: null, occurredAt: 1790000000, hours: 2 };

  afterEach(() => {
    syncManager.configure(tokens, 'https://api.example.com');
  });

  test("A's queued attendance is never sent under B, and sends when A signs in again", async () => {
    (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: false });
    syncManager.configure(memberA, 'https://api.example.com');
    await syncManager.enqueueAttendance('attendance-a', 'Attendance — Drill', entry);
    await flush();
    expect((await store.find('attendance-a'))?.ownerMemberId).toBe('member-a');
    expect((await store.find('attendance-a'))?.ownerDeptId).toBe('nichols');

    // A signs out; B signs in with signal.
    syncManager.configure(null, null);
    (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: true });
    mockApiRequest.mockResolvedValue({ json: async () => entry });
    syncManager.configure(memberB, 'https://api.example.com');
    await syncManager.drainAndSettle();
    await flush();

    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(await store.find('attendance-a')).toBeDefined();
    const seenByB = await outbox.getStatus(null, 'member-b');
    expect(seenByB.items).toHaveLength(0);
    expect(seenByB.heldForOtherMembers).toBe(1);

    syncManager.configure(memberA, 'https://api.example.com');
    await flush();
    await flush();
    expect(mockApiRequest).toHaveBeenCalledWith(
      'personnel/attendance',
      memberA,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('a row with no recorded owner is held until the signed-in member sends it as theirs', async () => {
    await store.insert({
      id: 'legacy-1',
      kind: 'ATTENDANCE',
      label: 'Attendance — Drill',
      method: 'POST',
      path: 'personnel/attendance',
      body: JSON.stringify(entry),
      stage: 'CREATE',
      photoLocalUri: null,
      photoS3Key: null,
      photoUploadUrl: null,
      status: 'QUEUED',
      attempts: 0,
      lastError: null,
      queuedAt: new Date().toISOString(),
      nextAttemptAt: Date.now(),
      syncedAt: null,
      ownerMemberId: null,
      ownerDeptId: null,
    });
    (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: true });
    mockApiRequest.mockResolvedValue({ json: async () => entry });
    syncManager.configure(memberB, 'https://api.example.com');
    await flush();
    await flush();

    expect(mockApiRequest).not.toHaveBeenCalled();
    const status = await outbox.getStatus(null, 'member-b');
    expect(status.items).toEqual([expect.objectContaining({ id: 'legacy-1', needsOwner: true })]);

    await syncManager.sendAsMe('legacy-1');
    await flush();
    await flush();
    expect(mockApiRequest).toHaveBeenCalledWith('personnel/attendance', memberB, expect.anything());
  });

  test('a member can count and discard their own unsent items at sign-out', async () => {
    syncManager.configure(null, null);
    syncManager.configure(memberA, null);
    await syncManager.enqueueAttendance('attendance-a2', 'Attendance — Drill', entry);
    expect(await syncManager.countUnsentFor('member-a')).toBe(1);
    expect(await syncManager.countUnsentFor('member-b')).toBe(0);
    await syncManager.discardAllFor('member-a');
    expect(await store.find('attendance-a2')).toBeUndefined();
  });
});

test('drainBriefly sends queued work but never holds sign-out past its time limit', async () => {
  mockApiRequest.mockResolvedValueOnce({ json: async () => ({}) });
  syncManager.configure(null, null);
  syncManager.setOwnerResolver(async () => ({ memberId: 'm-test', deptId: null }));
  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-brief', {});
  syncManager.setOwnerResolver(null);
  syncManager.configure(tokens, 'https://api.example.com');
  await syncManager.drainBriefly(3000);
  await expect(store.find('check-brief')).resolves.toBeUndefined();

  // A server that doesn't answer in time: drainBriefly returns at the limit anyway.
  let answer: () => void = () => undefined;
  mockApiRequest.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = () => resolve({ json: async () => ({}) });
      }),
  );
  await syncManager.enqueueChecklistRun('ENGINE-2', 'check-hang', {});
  const started = Date.now();
  await syncManager.drainBriefly(50);
  expect(Date.now() - started).toBeLessThan(2000);
  // Let the abandoned drain finish so it doesn't hold the drain lock for later tests.
  answer();
  await syncManager.drainAndSettle();
});

// R5-M1: A signs out with a request in flight on a bad link; B signs in before it returns.
test("a drain still running when the member changes never posts A's next row with B's tokens", async () => {
  const memberA = { ...tokens, memberId: 'member-a' };
  const memberB = { ...tokens, memberId: 'member-b' };
  const entry = { activityType: 'DRILL', refId: null, occurredAt: 1790000000, hours: 2 };
  (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: false });
  syncManager.configure(memberA, 'https://api.example.com');
  await syncManager.enqueueAttendance('a-first', 'Attendance — Drill', entry);
  await syncManager.enqueueAttendance('a-second', 'Attendance — Drill', {
    ...entry,
    occurredAt: 1790000100,
  });
  await flush();

  let releaseFirst: () => void = () => undefined;
  mockApiRequest.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseFirst = () => resolve({ json: async () => entry });
      }),
  );
  mockApiRequest.mockResolvedValue({ json: async () => entry });
  (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: true });
  const running = syncManager.drainAndSettle();
  for (let i = 0; i < 20 && mockApiRequest.mock.calls.length === 0; i += 1) await flush();
  expect(mockApiRequest).toHaveBeenCalledTimes(1);

  // A signs out, B signs in, then A's in-flight request returns.
  syncManager.configure(null, null);
  syncManager.configure(memberB, 'https://api.example.com');
  releaseFirst();
  await running;
  await flush();

  expect(mockApiRequest.mock.calls.every(([, source]) => source !== memberB)).toBe(true);
  expect(mockApiRequest).toHaveBeenCalledTimes(1);
  expect((await store.find('a-second'))?.ownerMemberId).toBe('member-a');

  // A signs in again: the held row goes, under A.
  syncManager.configure(null, null);
  syncManager.configure(memberA, 'https://api.example.com');
  await flush();
  await flush();
  expect(mockApiRequest).toHaveBeenLastCalledWith(
    'personnel/attendance',
    memberA,
    expect.objectContaining({ body: expect.stringContaining('1790000100') }),
  );
  await expect(store.find('a-second')).resolves.toBeUndefined();
});

// m1: every call of a run - including the 401 retry inside apiRequest - uses a source pinned to
// the run's member, not the session source that reads whatever the keychain holds at call time.
test("a drain run sends with a source pinned to the run's member", async () => {
  const pinned = { getAccessToken: jest.fn(), renewSilently: jest.fn() };
  const forMember = jest.fn(() => pinned);
  const session = { ...tokens, memberId: 'member-p', forMember };
  syncManager.configure(session, 'https://api.example.com');
  await flush();
  mockApiRequest.mockResolvedValue({ json: async () => ({}) });

  await syncManager.enqueueChecklistRun('ENGINE-9', 'check-pinned', { templateId: 'CT-01' });
  await syncManager.drainAndSettle();

  expect(forMember).toHaveBeenCalledWith('member-p');
  expect(mockApiRequest).toHaveBeenCalledWith(
    'apparatus/ENGINE-9/checks',
    pinned,
    expect.anything(),
  );
});
