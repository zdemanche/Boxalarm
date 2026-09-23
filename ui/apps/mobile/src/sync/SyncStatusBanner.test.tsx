import { act, fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { mockSyncRepository } from '../features/sync/mockSyncRepository';
import { SyncStatusBanner } from './SyncStatusBanner';

test('shows the queued count and the failed item with a retry action', async () => {
  const { findByText, findByRole } = await render(<SyncStatusBanner />);

  expect(await findByText(/1 item waiting to sync/i)).toBeTruthy();
  expect(await findByText(/defect report — engine-2/i)).toBeTruthy();
  expect(await findByRole('button', { name: /retry/i })).toBeTruthy();
});

test('retrying a failed item removes it and announces the result', async () => {
  const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const { findByRole, queryByText } = await render(<SyncStatusBanner />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: /retry/i }));
  });

  expect(queryByText(/defect report — engine-2/i)).toBeNull();
  expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/synced/i));
  announceSpy.mockRestore();
});

test('cannot be dismissed while a failed item is outstanding, so it is never silently missed', async () => {
  const { queryByRole } = await render(<SyncStatusBanner />);
  expect(queryByRole('button', { name: 'Dismiss' })).toBeNull();
});

test('once caught up (no queued or failed items), shows a dismissible last-synced status', async () => {
  jest.spyOn(mockSyncRepository, 'getStatus').mockResolvedValueOnce({
    items: [],
    lastSyncAt: new Date().toISOString(),
  });

  const { findByText, findByRole } = await render(<SyncStatusBanner />);

  expect(await findByText(/synced/i)).toBeTruthy();
  expect(await findByRole('button', { name: 'Dismiss' })).toBeTruthy();
});
