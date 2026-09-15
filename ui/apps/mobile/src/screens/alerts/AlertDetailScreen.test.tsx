import { act, fireEvent, render } from '@testing-library/react-native';
import { mockAlertsRepository } from '../../features/alerts/mockAlertsRepository';
import { AlertDetailScreen } from './AlertDetailScreen';

const mockNavigate = jest.fn();
const mockRouteParams: { dispatchId: string } = { dispatchId: '' };

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useRoute: () => ({ params: mockRouteParams }),
}));

let dispatchId = '';

beforeEach(async () => {
  mockNavigate.mockClear();
  const result = await mockAlertsRepository.triggerSelfTest();
  dispatchId = result.dispatchId;
  mockRouteParams.dispatchId = dispatchId;
});

test('shows the dispatch details and the tone ladder panel', async () => {
  const { findByText } = await render(<AlertDetailScreen />);

  expect(await findByText('Self-test')).toBeTruthy();
  expect(await findByText(/awaiting your response/i)).toBeTruthy();
});

test('confirming Responding with an ETA records the response and shows it back', async () => {
  const { findByRole, findByText, findByPlaceholderText } = await render(<AlertDetailScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Responding' }));
  });
  await act(async () => {
    fireEvent.changeText(await findByPlaceholderText('ETA (optional)'), '15 minutes');
  });
  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Confirm' }));
  });

  expect(await findByText(/you responded: responding/i)).toBeTruthy();
});

test('tapping Not responding submits immediately without an ETA step', async () => {
  const { findByRole, findByText } = await render(<AlertDetailScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Not responding' }));
  });

  expect(await findByText(/you responded: not responding/i)).toBeTruthy();
});

test('viewing the roster navigates with the dispatch id', async () => {
  const { findByRole } = await render(<AlertDetailScreen />);

  fireEvent.press(await findByRole('button', { name: 'View roster' }));
  expect(mockNavigate).toHaveBeenCalledWith('Roster', { dispatchId });
});
