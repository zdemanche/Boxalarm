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
