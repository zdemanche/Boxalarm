import { act, fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import * as syncManager from './syncManager';
import { SyncStatusBanner } from './SyncStatusBanner';
import type { SyncQueueStatus } from '../features/sync/types';

jest.mock('./syncManager', () => ({
  subscribe: jest.fn(),
  retry: jest.fn().mockResolvedValue(undefined),
}));

const mockSubscribe = syncManager.subscribe as jest.Mock;
const mockRetry = syncManager.retry as jest.Mock;

const QUEUED_AND_FAILED: SyncQueueStatus = {
  items: [
    {
      id: 'SYNC-1',
      kind: 'CHECKLIST_RUN',
      label: 'Truck check — ENGINE-2',
      status: 'QUEUED',
      queuedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      lastError: null,
    },
    {
      id: 'SYNC-2',
      kind: 'DEFECT',
      label: 'Defect report — ENGINE-2',
      status: 'FAILED',
      queuedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      lastError: 'Network unreachable',
    },
  ],
  lastSyncAt: new Date(Date.now() - 5 * 60_000).toISOString(),
};

function mockStatus(status: SyncQueueStatus) {
  mockSubscribe.mockImplementation((listener: (next: SyncQueueStatus) => void) => {
    listener(status);
    return () => undefined;
  });
}

beforeEach(() => {
  mockSubscribe.mockReset();
  mockRetry.mockReset().mockResolvedValue(undefined);
});

test('shows the queued count and the failed item with a retry action', async () => {
  mockStatus(QUEUED_AND_FAILED);
  const { findByText, findByRole } = await render(<SyncStatusBanner />);

  expect(await findByText(/1 item waiting to sync/i)).toBeTruthy();
  expect(await findByText(/defect report — engine-2/i)).toBeTruthy();
  expect(await findByRole('button', { name: /retry/i })).toBeTruthy();
});

test('retrying a failed item calls the sync manager and announces it, never silently', async () => {
  mockStatus(QUEUED_AND_FAILED);
  const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const { findByRole } = await render(<SyncStatusBanner />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: /retry/i }));
  });

  expect(mockRetry).toHaveBeenCalledWith('SYNC-2');
  expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/retrying/i));
  announceSpy.mockRestore();
});

test('a live status update (e.g. a successful drain) removes the item without a remount', async () => {
  let emit: (next: SyncQueueStatus) => void = () => undefined;
  mockSubscribe.mockImplementation((listener: (next: SyncQueueStatus) => void) => {
    emit = listener;
    listener(QUEUED_AND_FAILED);
    return () => undefined;
  });

  const { findByText, queryByText } = await render(<SyncStatusBanner />);
  await findByText(/defect report — engine-2/i);

  await act(async () => {
    emit({ items: [], lastSyncAt: new Date().toISOString() });
  });

  expect(queryByText(/defect report — engine-2/i)).toBeNull();
});

test('cannot be dismissed while a failed item is outstanding, so it is never silently missed', async () => {
  mockStatus(QUEUED_AND_FAILED);
  const { queryByRole } = await render(<SyncStatusBanner />);
  expect(queryByRole('button', { name: 'Dismiss' })).toBeNull();
});

test('once caught up (no queued or failed items), shows a dismissible last-synced status', async () => {
  mockStatus({ items: [], lastSyncAt: new Date().toISOString() });

  const { findByText, findByRole } = await render(<SyncStatusBanner />);

  expect(await findByText(/synced/i)).toBeTruthy();
  expect(await findByRole('button', { name: 'Dismiss' })).toBeTruthy();
});
