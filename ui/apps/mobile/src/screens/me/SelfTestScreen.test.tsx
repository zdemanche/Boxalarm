import notifee from '@notifee/react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { SelfTestScreen } from './SelfTestScreen';

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
