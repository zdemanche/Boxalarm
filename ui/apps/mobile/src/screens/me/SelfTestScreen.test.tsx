import { fireEvent, render } from '@testing-library/react-native';
import { SelfTestScreen } from './SelfTestScreen';

test('running the self-test before backend access exists shows an honest not-yet-available message', async () => {
  const { findByRole, findByText } = await render(<SelfTestScreen />);

  fireEvent.press(await findByRole('button', { name: 'Run self-test' }));
  expect(await findByText(/not yet connected/i)).toBeTruthy();
});
