import { palette, touchTarget } from '@boxalarm/design-tokens';
import { act, fireEvent, render } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import { AccessibilityInfo } from 'react-native';
import { DefectReportScreen } from './DefectReportScreen';
import { mockChecksRepository } from '../../features/checks/mockChecksRepository';

const mockRoute = { params: { apparatusId: 'APP-ENGINE-2' } };
jest.mock('@react-navigation/native', () => ({
  useRoute: () => mockRoute,
  useNavigation: () => ({ goBack: jest.fn() }),
}));

test('mentions that a photo attachment is not yet connected', async () => {
  const { findByText } = await render(<DefectReportScreen />);
  expect(await findByText(/not yet connected/i)).toBeTruthy();
});

test('submitting a defect report calls submitDefect with the entered description and severity', async () => {
  const submitSpy = jest.spyOn(mockChecksRepository, 'submitDefect');
  const { findByText, findByPlaceholderText } = await render(<DefectReportScreen />);

  const input = await findByPlaceholderText('Describe the defect');
  await act(async () => {
    fireEvent.changeText(input, 'Low tire pressure, rear axle');
  });
  await act(async () => {
    fireEvent.press(await findByText('Major'));
  });
  await act(async () => {
    fireEvent.press(await findByText('Submit defect report'));
  });

  expect(submitSpy).toHaveBeenCalledWith({
    apparatusId: 'APP-ENGINE-2',
    description: 'Low tire pressure, rear axle',
    severity: 'MAJOR',
  });
  submitSpy.mockRestore();
});

test('announces the confirmation for screen reader users, since the screen swaps entirely', async () => {
  const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const { findByPlaceholderText, findByText } = await render(<DefectReportScreen />);

  await act(async () => {
    fireEvent.changeText(await findByPlaceholderText('Describe the defect'), 'x');
  });
  await act(async () => {
    fireEvent.press(await findByText('Submit defect report'));
  });

  expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/defect reported/i));
  announceSpy.mockRestore();
});

test('the post-submit Back link meets the N3.5 baseline touch target, not just its text height', async () => {
  const { findByText, findByPlaceholderText, findByRole } = await render(<DefectReportScreen />);

  await act(async () => {
    fireEvent.changeText(await findByPlaceholderText('Describe the defect'), 'x');
  });
  await act(async () => {
    fireEvent.press(await findByText('Submit defect report'));
  });

  const backLink = await findByRole('button', { name: 'Back' });
  expect(backLink.props.style.minHeight).toBe(touchTarget.baseline.ios);
});

test('the submit button label uses the cab palette token, not a hardcoded color, so it stays legible in cab mode', async () => {
  // Day mode's background (white) happens to equal a hardcoded '#ffffff', which would hide a
  // missed-token bug there - cab mode is the case that actually proves the label color comes
  // from the palette, not a literal, since cab.background is near-black.
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue('dark');

  const { findByText } = await render(<DefectReportScreen />);
  const label = await findByText('Submit defect report');

  expect(label.props.style.color).toBe(palette.cab.background);
});

test('selecting out-of-service severity shows the OOS consequence without a separate step', async () => {
  const { findByText, queryByText } = await render(<DefectReportScreen />);

  expect(queryByText(/takes the unit out of service/i)).toBeNull();

  await act(async () => {
    fireEvent.press(await findByText('Out of service'));
  });

  expect(
    await findByText('This takes the unit out of service and alerts the apparatus officer.'),
  ).toBeTruthy();
});
