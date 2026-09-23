import { fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { SelfTestScreen } from './SelfTestScreen';

test('pressing run self-test points the member at the real flow in the Alerts tab', async () => {
  const { findByRole, findByText } = await render(<SelfTestScreen />);

  fireEvent.press(await findByRole('button', { name: 'Run self-test' }));
  expect(await findByText(/alerts tab/i)).toBeTruthy();
});

test('announces the redirect message for screen reader users', async () => {
  const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const { findByRole } = await render(<SelfTestScreen />);

  fireEvent.press(await findByRole('button', { name: 'Run self-test' }));

  expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/alerts tab/i));
  announceSpy.mockRestore();
});
