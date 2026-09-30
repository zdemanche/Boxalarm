// R3-C1: an alert answer given from the lock screen, before any session is configured, must be
// stamped with the stored session's member and must never be stranded by owner scoping.
import notifee, { EventType, type Event } from '@notifee/react-native';
import NetInfo from '@react-native-community/netinfo';
import { getInternetCredentials } from 'react-native-keychain';
import { apiRequest } from '../lib/apiClient';
import { handleNotificationEvent } from '../features/alerts/notificationActions';
import { migrateOutboxOwnerColumns } from './db';
import { kvDelete, kvSet } from './kvStore';
import { LAST_SESSION_SUB_KEY } from './memberCache';
import * as outbox from './outbox';
import * as store from './outboxStore';
import * as syncManager from './syncManager';

jest.mock('../lib/apiClient', () => ({
  ...jest.requireActual('../lib/apiClient'),
  apiRequest: jest.fn(),
}));
jest.mock('react-native-config', () => ({
  __esModule: true,
  default: { API_BASE_URL: 'https://api.example.com' },
}));
jest.mock('react-native-keychain', () => ({
  getInternetCredentials: jest.fn(async () => false),
  setInternetCredentials: jest.fn(async () => true),
  resetInternetCredentials: jest.fn(async () => true),
  ACCESSIBLE: { AFTER_FIRST_UNLOCK: 'AfterFirstUnlock' },
}));

const mockApiRequest = apiRequest as jest.Mock;
const mockCredentials = getInternetCredentials as jest.Mock;
const displayNotification = notifee.displayNotification as jest.Mock;

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function storedSession(claims: Record<string, unknown>) {
  return {
    username: 'boxalarm-auth',
    password: JSON.stringify({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessTokenExpirationDate: new Date(Date.now() + 3600_000).toISOString(),
      idToken: `h.${base64url(JSON.stringify(claims))}.s`,
    }),
  };
}

const pressResponding = {
  type: EventType.ACTION_PRESS,
  detail: {
    pressAction: { id: 'respond:RESPONDING' },
    notification: {
      id: 'dispatch:D-LOCK',
      data: {
        dispatchId: 'D-LOCK',
        incidentType: 'Structure fire',
        address: '21 Main St',
        receivedAt: '1000',
        category: 'dispatch',
      },
    },
  },
} as Event;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const memberK = {
  getAccessToken: jest.fn(async () => 'access-1'),
  renewSilently: jest.fn(async () => null),
  memberId: 'member-k',
  deptId: 'nichols',
};

beforeEach(async () => {
  const rows = await store.all();
  await Promise.all(rows.map((row) => store.remove(row.id)));
  mockApiRequest.mockReset();
  displayNotification.mockReset().mockResolvedValue(undefined);
  (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: true });
  syncManager.configure(null, null);
});

test('a lock-screen answer with no session configured is stamped with the stored member, and sends once they sign in', async () => {
  mockCredentials.mockResolvedValue(storedSession({ sub: 'member-k', 'custom:deptId': 'nichols' }));
  // The headless send fails: no answer from the server in the apparatus bay.
  mockApiRequest.mockRejectedValue(new TypeError('Network request failed'));

  await handleNotificationEvent(pressResponding);

  const [row] = await store.all();
  expect(row).toMatchObject({
    kind: 'RESPONSE',
    ownerMemberId: 'member-k',
    ownerDeptId: 'nichols',
  });
  expect(row?.status).toBe('FAILED');

  // Later, the app starts with the member's session.
  syncManager.configure(null, null);
  mockApiRequest.mockReset().mockResolvedValue({ json: async () => ({}) });
  syncManager.configure(memberK, 'https://api.example.com');
  await syncManager.retry(row!.id);
  await flush();
  await flush();

  expect(mockApiRequest).toHaveBeenCalledWith(
    'alerting/dispatches/D-LOCK/responses',
    memberK,
    expect.objectContaining({ method: 'POST' }),
  );
  await expect(store.find(row!.id)).resolves.toBeUndefined();
});

// R4-M1: a phone with no stored session has nobody to answer as.
test('signed out: a lock-screen answer is not queued, and a different member signing in sends nothing', async () => {
  mockCredentials.mockResolvedValue(false);
  mockApiRequest.mockResolvedValue({ json: async () => ({}) });

  await handleNotificationEvent(pressResponding);

  expect(await store.all()).toEqual([]);
  const last = displayNotification.mock.calls.at(-1)![0];
  expect(last.body).toMatch(/^You're signed out on this phone\. Open Boxalarm and sign in/);

  // Member B signs in within the answer window.
  syncManager.configure({ ...memberK, memberId: 'member-b' }, 'https://api.example.com');
  await flush();
  await flush();
  expect(mockApiRequest).not.toHaveBeenCalled();
});

test('a keychain read failure queues the answer ownerless with a hint; only that member sends it', async () => {
  mockCredentials.mockRejectedValue(new Error('keychain unavailable'));
  await kvSet(LAST_SESSION_SUB_KEY, 'member-k');
  mockApiRequest.mockRejectedValue(new TypeError('Network request failed'));

  await handleNotificationEvent(pressResponding);

  const [row] = await store.all();
  expect(row).toMatchObject({ ownerMemberId: null, answeredAsHint: 'member-k' });

  // Another member signing in does not send it; it is offered for Send/Discard instead.
  mockApiRequest.mockReset().mockResolvedValue({ json: async () => ({}) });
  syncManager.configure({ ...memberK, memberId: 'member-b' }, 'https://api.example.com');
  await syncManager.retry(row!.id);
  await flush();
  await flush();
  expect(mockApiRequest).not.toHaveBeenCalled();
  expect((await outbox.getStatus(null, 'member-b')).items).toEqual([
    expect.objectContaining({ id: row!.id, needsOwner: true }),
  ]);

  // The member who was signed in sends it automatically.
  syncManager.configure(null, null);
  syncManager.configure(memberK, 'https://api.example.com');
  await flush();
  await flush();
  expect(mockApiRequest).toHaveBeenCalledWith(
    'alerting/dispatches/D-LOCK/responses',
    memberK,
    expect.anything(),
  );
  await kvDelete(LAST_SESSION_SUB_KEY);
});

test('an ownerless answer older than the 2 h window is past its call: it is dropped, not sent', async () => {
  await store.insert({
    id: 'resp-old',
    kind: 'RESPONSE',
    label: 'Responding — D-OLD',
    method: 'POST',
    path: 'alerting/dispatches/D-OLD/responses',
    body: '{}',
    stage: 'CREATE',
    photoLocalUri: null,
    photoS3Key: null,
    photoUploadUrl: null,
    status: 'QUEUED',
    attempts: 0,
    lastError: null,
    queuedAt: new Date(Date.now() - outbox.OWNERLESS_RESPONSE_WINDOW_MS - 60_000).toISOString(),
    nextAttemptAt: Date.now(),
    syncedAt: null,
    // One pre-release build stamped '' for "no member id": treated exactly like NULL.
    ownerMemberId: '',
    ownerDeptId: null,
    answeredAsHint: 'member-k',
  });
  mockApiRequest.mockResolvedValue({ json: async () => ({}) });
  syncManager.configure(memberK, 'https://api.example.com');
  await flush();
  await flush();

  expect(mockApiRequest).not.toHaveBeenCalled();
  await expect(store.find('resp-old')).resolves.toBeUndefined();
});

test('an owned answer is never dropped by the stale-answer rule, however old', async () => {
  await store.insert({
    id: 'resp-owned-old',
    kind: 'RESPONSE',
    label: 'Responding — D-OLD',
    method: 'POST',
    path: 'alerting/dispatches/D-OLD/responses',
    body: '{}',
    stage: 'CREATE',
    photoLocalUri: null,
    photoS3Key: null,
    photoUploadUrl: null,
    status: 'FAILED',
    attempts: 1,
    lastError: 'offline',
    queuedAt: new Date(Date.now() - 3 * outbox.OWNERLESS_RESPONSE_WINDOW_MS).toISOString(),
    nextAttemptAt: Date.now() + 60_000,
    syncedAt: null,
    ownerMemberId: 'member-k',
    ownerDeptId: null,
  });

  expect(await outbox.discardStaleOwnerlessResponses(Date.now())).toBe(0);
  expect(await store.find('resp-owned-old')).toBeDefined();
});

describe('owner-column migration on an existing outbox', () => {
  function fakeDb(columns: string[], alterFails = false) {
    const statements: string[] = [];
    return {
      statements,
      executeSync: jest.fn((sql: string) => {
        statements.push(sql);
        if (sql.startsWith('PRAGMA')) return { rows: columns.map((name) => ({ name })) };
        if (alterFails) throw new Error('database is locked');
        return { rows: [] };
      }),
    };
  }

  test('adds only the missing owner columns to a table that predates them', () => {
    const db = fakeDb(['id', 'kind', 'status']);
    expect(migrateOutboxOwnerColumns(db as never)).toBe(true);
    expect(db.statements).toEqual([
      'PRAGMA table_info(outbox)',
      'ALTER TABLE outbox ADD COLUMN ownerMemberId TEXT',
      'ALTER TABLE outbox ADD COLUMN ownerDeptId TEXT',
      'ALTER TABLE outbox ADD COLUMN answeredAsHint TEXT',
    ]);
  });

  test('does nothing when the columns are already there', () => {
    const db = fakeDb(['id', 'ownerMemberId', 'ownerDeptId', 'answeredAsHint']);
    expect(migrateOutboxOwnerColumns(db as never)).toBe(true);
    expect(db.statements).toEqual(['PRAGMA table_info(outbox)']);
  });

  test('a failed ALTER is logged and reported, so the outbox falls back instead of throwing', () => {
    const log = jest.fn();
    const db = fakeDb(['id'], true);
    expect(migrateOutboxOwnerColumns(db as never, log)).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/owner columns failed/),
      expect.any(Error),
    );
  });
});
