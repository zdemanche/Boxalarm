import { touchTarget } from '@boxalarm/design-tokens';
import { act, fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { mockAlertsRepository } from '../../features/alerts/mockAlertsRepository';
import { AlertDetailScreen } from './AlertDetailScreen';

const mockNavigate = jest.fn();
const mockRouteParams: { dispatchId: string; payload?: unknown } = { dispatchId: '' };

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
  delete mockRouteParams.payload;
});

afterEach(() => {
  jest.restoreAllMocks();
});

const PAGE = {
  dispatchId: 'DISP-PAGE',
  incidentType: 'Structure fire',
  address: '21 Main St',
  crossStreets: 'Elm / Oak',
  receivedAt: Date.now(),
};

test('paints the address and live response buttons from the page payload while the fetch is still pending', async () => {
  jest.spyOn(mockAlertsRepository, 'getDispatch').mockImplementation(() => new Promise(() => {}));
  mockRouteParams.dispatchId = PAGE.dispatchId;
  mockRouteParams.payload = PAGE;

  const { findByText, findByRole } = await render(<AlertDetailScreen />);

  expect(await findByText('21 Main St')).toBeTruthy();
  expect(await findByText(/Structure fire/)).toBeTruthy();
  expect(await findByRole('button', { name: 'Not responding' })).toBeTruthy();
});

test('a failed fetch is a named, retryable state that keeps the page address - never a blank screen', async () => {
  const getDispatch = jest
    .spyOn(mockAlertsRepository, 'getDispatch')
    .mockRejectedValueOnce(new TypeError('Network request failed'));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockRouteParams.dispatchId = PAGE.dispatchId;
  mockRouteParams.payload = PAGE;

  const { findByText, findByRole } = await render(<AlertDetailScreen />);

  expect(await findByText(/the address above came with the page and is correct/i)).toBeTruthy();
  expect(await findByText('21 Main St')).toBeTruthy();

  getDispatch.mockResolvedValueOnce({
    dispatchId: PAGE.dispatchId,
    incidentType: 'Structure fire',
    address: '21 Main St',
    crossStreets: 'Elm / Oak',
    mapLink: null,
    narrative: 'Smoke showing from the second floor',
    isSelfTest: false,
  });
  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Retry loading the call details' }));
  });

  expect(await findByText('Smoke showing from the second floor')).toBeTruthy();
});

test('with no payload and a failed fetch the screen still names the call and keeps the buttons live', async () => {
  jest.spyOn(mockAlertsRepository, 'getDispatch').mockRejectedValue(new Error('boom'));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockRouteParams.dispatchId = 'DISP-UNKNOWN';

  const { findByText, findByRole } = await render(<AlertDetailScreen />);

  expect(await findByText('Dispatch DISP-UNKNOWN')).toBeTruthy();
  expect(await findByText(/your response buttons still work/i)).toBeTruthy();
  expect(await findByRole('button', { name: 'Responding' })).toBeTruthy();
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
    fireEvent.changeText(await findByPlaceholderText('ETA in minutes'), '15');
  });
  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Confirm' }));
  });

  expect(await findByText(/your response: responding/i)).toBeTruthy();
});

test('tapping Not responding submits immediately without an ETA step', async () => {
  const { findByRole, findByText } = await render(<AlertDetailScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Not responding' }));
  });

  expect(await findByText(/your response: not responding/i)).toBeTruthy();
});

test('announces the recorded response for screen reader users', async () => {
  const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const { findByRole } = await render(<AlertDetailScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Not responding' }));
  });

  expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/not responding/i));
  announceSpy.mockRestore();
});

test('Confirm shares the oversized touch target with Responding/Not responding (glove/moving-vehicle context)', async () => {
  const { findByRole } = await render(<AlertDetailScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Responding' }));
  });
  const confirmButton = await findByRole('button', { name: 'Confirm' });

  expect(confirmButton.props.style.minHeight).toBe(touchTarget.oversized.ios);
});

test('tapping Direct to scene is distinct in text from Responding', async () => {
  const { findByRole, findByText, findByPlaceholderText } = await render(<AlertDetailScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Direct to scene' }));
  });
  await act(async () => {
    fireEvent.changeText(await findByPlaceholderText('ETA in minutes'), '5');
  });
  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Confirm' }));
  });

  expect(await findByText(/your response: direct to scene/i)).toBeTruthy();
});

test('viewing the roster navigates with the dispatch id', async () => {
  const { findByRole } = await render(<AlertDetailScreen />);

  fireEvent.press(await findByRole('button', { name: 'View roster' }));
  expect(mockNavigate).toHaveBeenCalledWith('Roster', { dispatchId });
});
