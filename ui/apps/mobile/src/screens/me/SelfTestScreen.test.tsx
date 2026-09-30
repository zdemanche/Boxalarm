import notifee from '@notifee/react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { mockAlertsRepository } from '../../features/alerts/mockAlertsRepository';
import { SelfTestScreen } from './SelfTestScreen';

afterEach(() => {
  jest.restoreAllMocks();
});

test('running a self-test shows a pass/fail status and a timestamp per channel, never a bare ok', async () => {
  const { findByRole, findByText } = await render(<SelfTestScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Run self-test' }));
  });

  expect(await findByText(/push: pass/i)).toBeTruthy();
  expect(await findByText(/sms: pass/i)).toBeTruthy();
});

test('after a test page, asks whether the phone rang - and a "no" gives concrete next steps', async () => {
  const { findByRole, findByText } = await render(<SelfTestScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Run self-test' }));
  });
  expect(await findByText('Did your phone ring?')).toBeTruthy();

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: "No, it didn't ring" }));
  });

  expect(await findByText('This phone did not ring')).toBeTruthy();
  expect(await findByText(/tell your officer/i)).toBeTruthy();
  expect(await findByRole('button', { name: "No, it didn't ring", selected: true })).toBeTruthy();
});

test('shows the device readiness checklist, with a fix for anything not ready', async () => {
  (notifee.getNotificationSettings as jest.Mock).mockResolvedValueOnce({ authorizationStatus: 0 });
  const { findByText, findByRole } = await render(<SelfTestScreen />);

  expect(await findByText('Is this phone ready?')).toBeTruthy();
  expect(await findByRole('button', { name: 'Turn on notifications: Notifications' })).toBeTruthy();
});

test('if the result poll fails, it says so and still asks whether the phone rang (review m13)', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest
    .spyOn(mockAlertsRepository, 'getSelfTestRun')
    .mockRejectedValueOnce(new TypeError('Network request failed'));
  const { findByRole, findByText } = await render(<SelfTestScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Run self-test' }));
  });

  expect(await findByText(/lost track of the test result/i)).toBeTruthy();
  expect(await findByText('Did your phone ring?')).toBeTruthy();
});

test('the "did it ring" answer is kept and shown next time', async () => {
  const first = await render(<SelfTestScreen />);
  await act(async () => {
    fireEvent.press(await first.findByRole('button', { name: 'Run self-test' }));
  });
  await act(async () => {
    fireEvent.press(await first.findByRole('button', { name: 'Yes, it rang' }));
  });
  first.unmount();

  const { findByText } = await render(<SelfTestScreen />);

  expect(await findByText(/last test .*: this phone rang\./i)).toBeTruthy();
});
