import { act, fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { mockSyncRepository } from '../../features/sync/mockSyncRepository';
import { FieldCaptureScreen } from './FieldCaptureScreen';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

test('submitting offline shows "saved offline, will sync" immediately (AC1)', async () => {
  const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const { findByText, findByLabelText } = await render(<FieldCaptureScreen />);

  await act(async () => {
    fireEvent.changeText(await findByLabelText('Occupancy ID'), 'occ-1');
  });
  await act(async () => {
    fireEvent.changeText(await findByLabelText('Inspection ID'), 'insp-1');
  });
  await act(async () => {
    fireEvent.press(await findByText('Submit capture'));
  });

  expect(await findByText('Saved offline, will sync')).toBeTruthy();
  expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/saved offline/i));
  announceSpy.mockRestore();
});

test('queues the capture on the shared sync outbox with a stable idempotency key (AC2)', async () => {
  const enqueueSpy = jest.spyOn(mockSyncRepository, 'enqueue');
  const { findByText, findByLabelText } = await render(<FieldCaptureScreen />);

  await act(async () => {
    fireEvent.changeText(await findByLabelText('Occupancy ID'), 'occ-1');
  });
  await act(async () => {
    fireEvent.changeText(await findByLabelText('Inspection ID'), 'insp-1');
  });
  await act(async () => {
    fireEvent.press(await findByText('Submit capture'));
  });

  expect(enqueueSpy).toHaveBeenCalledWith(
    'FIELD_CAPTURE',
    expect.stringContaining('occ-1'),
    expect.any(String),
  );
  const status = await mockSyncRepository.getStatus();
  expect(status.items.some((item) => item.kind === 'FIELD_CAPTURE')).toBe(true);
  enqueueSpy.mockRestore();
});
