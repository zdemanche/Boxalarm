import { fireEvent, render } from '@testing-library/react-native';
import { SelfTestScreen } from './SelfTestScreen';

test('pressing run self-test points the member at the real flow in the Alerts tab', async () => {
  const { findByRole, findByText } = await render(<SelfTestScreen />);

  fireEvent.press(await findByRole('button', { name: 'Run self-test' }));
  expect(await findByText(/alerts tab/i)).toBeTruthy();
});
