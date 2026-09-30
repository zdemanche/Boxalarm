// R3-C1: an alert answer given from the lock screen, before any session is configured, must be
// stamped with the stored session's member and must never be stranded by owner scoping.
import notifee, { EventType, type Event } from '@notifee/react-native';
import NetInfo from '@react-native-community/netinfo';
import { getInternetCredentials } from 'react-native-keychain';
import { apiRequest } from '../lib/apiClient';
import { handleNotificationEvent } from '../features/alerts/notificationActions';
import { migrateOutboxOwnerColumns } from './db';
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

test('an answer whose owner cannot be resolved is stored ownerless, never blank, and still sends', async () => {
  mockCredentials.mockResolvedValue(false);
  syncManager.configure(null, null);
  await syncManager.enqueueResponse('resp-ownerless', 'D-LOCK', 'Responding — D-LOCK', {
    ackStatus: 'RESPONDING',
  });
  const row = await store.find('resp-ownerless');
  expect(row?.ownerMemberId).toBeNull();

  mockApiRequest.mockResolvedValue({ json: async () => ({}) });
  syncManager.configure(memberK, 'https://api.example.com');
  await flush();
  await flush();

  expect(mockApiRequest).toHaveBeenCalledWith(
    'alerting/dispatches/D-LOCK/responses',
    memberK,
    expect.anything(),
  );
});

test('an ownerless answer older than 2 hours is not auto-sent: it is shown for Send or Discard', async () => {
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
  });
  mockApiRequest.mockResolvedValue({ json: async () => ({}) });
  syncManager.configure(memberK, 'https://api.example.com');
  await flush();
  await flush();

  expect(mockApiRequest).not.toHaveBeenCalled();
  const status = await outbox.getStatus(null, 'member-k');
  expect(status.items).toEqual([expect.objectContaining({ id: 'resp-old', needsOwner: true })]);
  expect(status.heldForOtherMembers).toBe(0);

  await syncManager.sendAsMe('resp-old');
  await flush();
  await flush();
  expect(mockApiRequest).toHaveBeenCalledWith(
    'alerting/dispatches/D-OLD/responses',
    memberK,
    expect.anything(),
  );
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
    ]);
  });

  test('does nothing when the columns are already there', () => {
    const db = fakeDb(['id', 'ownerMemberId', 'ownerDeptId']);
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
