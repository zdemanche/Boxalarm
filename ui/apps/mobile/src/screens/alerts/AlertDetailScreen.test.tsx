import { act, fireEvent, render } from '@testing-library/react-native';
import notifee from '@notifee/react-native';
import { AccessibilityInfo, AppState, NativeModules, Platform } from 'react-native';
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
  expect(await findByText('STRUCTURE FIRE')).toBeTruthy();
  expect(await findByRole('button', { name: /^Not responding/ })).toBeTruthy();
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

  expect(await findByText('DISPATCH DISP-UNKNOWN')).toBeTruthy();
  expect(await findByText(/your response buttons still work/i)).toBeTruthy();
  expect(await findByRole('button', { name: /^Responding — / })).toBeTruthy();
});

test('shows the dispatch details and the tone ladder panel', async () => {
  const { findByText } = await render(<AlertDetailScreen />);

  expect(await findByText('SELF-TEST')).toBeTruthy();
  expect(await findByText(/awaiting your response/i)).toBeTruthy();
});

const RESPONDING = /^Responding — you're going to the station/;
const DIRECT = /^Responding direct to scene/;
const NOT_RESPONDING = /^Not responding/;

test('one tap on Responding records it at once with a default ETA - no keyboard, no second screen', async () => {
  const { findByRole, findByText } = await render(<AlertDetailScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: RESPONDING }));
  });

  expect(await findByText(/your response: responding · eta 10 min/i)).toBeTruthy();
  expect(await findByRole('radio', { name: 'ETA 10 minutes', selected: true })).toBeTruthy();
});

test('an ETA chip changes the ETA in one tap', async () => {
  const { findByRole, findByText } = await render(<AlertDetailScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: DIRECT }));
  });
  await act(async () => {
    fireEvent.press(await findByRole('radio', { name: 'ETA 5 minutes' }));
  });

  expect(await findByText(/your response: direct to scene · eta 5 min/i)).toBeTruthy();
  expect(await findByRole('radio', { name: 'ETA 5 minutes', selected: true })).toBeTruthy();
});

test('the ETA chips are 5 / 10 / 15 / 20 and alert-path sized', async () => {
  const { findByRole, findAllByRole } = await render(<AlertDetailScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: RESPONDING }));
  });
  const chips = await findAllByRole('radio');

  expect(chips.map((chip) => chip.props.accessibilityLabel)).toEqual([
    'ETA 5 minutes',
    'ETA 10 minutes',
    'ETA 15 minutes',
    'ETA 20 minutes',
  ]);
  chips.forEach((chip) => expect(chip.props.style.minHeight).toBeGreaterThanOrEqual(72));
});

test('tapping Not responding records it immediately, with no ETA', async () => {
  const { findByRole, findByText, queryAllByRole } = await render(<AlertDetailScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: NOT_RESPONDING }));
  });

  expect(await findByText(/your response: not responding/i)).toBeTruthy();
  expect(queryAllByRole('radio')).toHaveLength(0);
});

test('the answer can be changed, and the selected answer is exposed to screen readers', async () => {
  const { findByRole, findByText } = await render(<AlertDetailScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: NOT_RESPONDING }));
  });
  await act(async () => {
    fireEvent.press(await findByRole('button', { name: RESPONDING }));
  });

  expect(await findByText(/your response: responding/i)).toBeTruthy();
  const chosen = await findByRole('button', { name: RESPONDING, selected: true });
  expect(chosen.props.accessibilityLabel).toMatch(/your answer, sent/i);
  expect(await findByRole('button', { name: NOT_RESPONDING, selected: false })).toBeTruthy();
});

test('announces the recorded response for screen reader users', async () => {
  const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const { findByRole } = await render(<AlertDetailScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: NOT_RESPONDING }));
  });

  expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/not responding/i));
  announceSpy.mockRestore();
});

test('layout per a11y-spec N1: stacked answers - Responding 88 tall, the others 72 - above the narrative', async () => {
  const { findByRole, findByText } = await render(<AlertDetailScreen />);

  const responding = await findByRole('button', { name: RESPONDING });
  const direct = await findByRole('button', { name: DIRECT });
  const notResponding = await findByRole('button', { name: NOT_RESPONDING });
  expect(responding.props.style.minHeight).toBe(88);
  expect(direct.props.style.minHeight).toBe(72);
  expect(notResponding.props.style.minHeight).toBe(72);
  expect(responding.props.style.width).toBe('100%');

  // Tree order is reading order: the answers come before the narrative.
  const narrative = await findByText(/self-test alert/i);
  const order = (node: { parent: unknown }) => {
    const path: number[] = [];
    let current = node as { parent: { children: unknown[] } | null };
    while (current.parent) {
      path.unshift(current.parent.children.indexOf(current));
      current = current.parent as unknown as { parent: { children: unknown[] } | null };
    }
    return path;
  };
  const before = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) return a[i]! < b[i]!;
    }
    return a.length < b.length;
  };
  expect(before(order(notResponding as never), order(narrative as never))).toBe(true);
});

test('the address is 32 pt, and a VERIFY ADDRESS pre-plan match is raised directly under it', async () => {
  jest.spyOn(mockAlertsRepository, 'getDispatch').mockResolvedValue({
    dispatchId: PAGE.dispatchId,
    incidentType: 'Structure fire',
    address: '21 Main St',
    crossStreets: '',
    mapLink: null,
    narrative: '',
    isSelfTest: false,
    prePlan: {
      matchType: 'NEARBY',
      matchedAddress: '23 Main St',
      distanceMeters: 40,
      hazards: [],
      utilityShutoffs: [],
      nearestHydrants: [],
    },
  });
  mockRouteParams.dispatchId = PAGE.dispatchId;
  mockRouteParams.payload = PAGE;

  const { findByText, findAllByText } = await render(<AlertDetailScreen />);

  expect((await findByText('21 Main St')).props.style.fontSize).toBe(32);
  const notices = await findAllByText(/VERIFY ADDRESS: nearby pre-plan for 23 Main St/);
  expect(notices.length).toBeGreaterThanOrEqual(1);
});

test('the voice-over rotor answers without finding the button (accessibilityActions)', async () => {
  const { findByLabelText, findByText } = await render(<AlertDetailScreen />);

  const root = await findByLabelText('Incoming call');
  await act(async () => {
    root.props.onAccessibilityAction({ nativeEvent: { actionName: 'notResponding' } });
  });

  expect(await findByText(/your response: not responding/i)).toBeTruthy();
});

test('viewing the roster navigates with the dispatch id', async () => {
  const { findByRole } = await render(<AlertDetailScreen />);

  fireEvent.press(await findByRole('button', { name: 'View roster' }));
  expect(mockNavigate).toHaveBeenCalledWith('Roster', { dispatchId });
});

test('the same screen re-rendered for a second call shows the second call - never the first call’s address (review CR-1)', async () => {
  const pageA = { ...PAGE, dispatchId: 'DISP-A', address: '1 First St', incidentType: 'MVA' };
  const pageB = { ...PAGE, dispatchId: 'DISP-B', address: '2 Second Ave', incidentType: 'Alarm' };
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  const getDispatch = jest.spyOn(mockAlertsRepository, 'getDispatch').mockResolvedValueOnce({
    dispatchId: 'DISP-A',
    incidentType: 'MVA',
    address: '1 First St',
    crossStreets: '',
    mapLink: 'https://maps.example/a',
    narrative: 'Call A narrative',
    isSelfTest: false,
  });
  mockRouteParams.dispatchId = 'DISP-A';
  mockRouteParams.payload = pageA;
  const view = await render(<AlertDetailScreen />);
  expect(await view.findByText('Call A narrative')).toBeTruthy();

  // Call B arrives while offline: same instance, new params, fetch fails.
  getDispatch.mockRejectedValueOnce(new TypeError('Network request failed'));
  mockRouteParams.dispatchId = 'DISP-B';
  mockRouteParams.payload = pageB;
  await act(async () => {
    view.rerender(<AlertDetailScreen />);
  });

  expect(await view.findByText('2 Second Ave')).toBeTruthy();
  expect(view.queryByText('1 First St')).toBeNull();
  expect(view.queryByText('Call A narrative')).toBeNull();
  expect(view.queryByRole('button', { name: 'Open the address in maps' })).toBeNull();
  expect(
    await view.findByText(/the address above came with the page and is correct/i),
  ).toBeTruthy();
});

test('a detail answered for another dispatch is ignored, not shown', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(mockAlertsRepository, 'getDispatch').mockResolvedValue({
    dispatchId: 'SOMETHING-ELSE',
    incidentType: 'MVA',
    address: '9 Wrong Rd',
    crossStreets: '',
    mapLink: null,
    narrative: '',
    isSelfTest: false,
  });
  mockRouteParams.dispatchId = PAGE.dispatchId;
  mockRouteParams.payload = PAGE;

  const { findByText, queryByText } = await render(<AlertDetailScreen />);

  expect(await findByText('21 Main St')).toBeTruthy();
  expect(queryByText('9 Wrong Rd')).toBeNull();
});

describe('alarm silencing and lock screen (review CR-2)', () => {
  const nativeModules = NativeModules as { BoxalarmAlertReadiness?: unknown };
  let locked: boolean;
  let setShowWhenLocked: jest.Mock;

  beforeEach(() => {
    Platform.OS = 'android';
    locked = true;
    setShowWhenLocked = jest.fn();
    nativeModules.BoxalarmAlertReadiness = {
      isKeyguardLocked: jest.fn(async () => locked),
      setShowWhenLocked,
    };
    (notifee.cancelDisplayedNotification as jest.Mock).mockClear();
  });

  afterEach(() => {
    delete nativeModules.BoxalarmAlertReadiness;
    Platform.OS = 'ios';
  });

  test('on a locked phone, opening the alert keeps it ringing and over the lock screen until the member acts', async () => {
    const view = await render(<AlertDetailScreen />);
    await view.findByRole('button', { name: RESPONDING });
    await act(async () => {});

    expect(notifee.cancelDisplayedNotification).not.toHaveBeenCalled();
    expect(setShowWhenLocked).toHaveBeenCalledWith(true);
    expect(setShowWhenLocked).not.toHaveBeenCalledWith(false);

    await act(async () => {
      fireEvent.press(await view.findByRole('button', { name: RESPONDING }));
    });
    expect(notifee.cancelDisplayedNotification).toHaveBeenCalledWith(`dispatch:${dispatchId}`);
  });

  test('unmounting the alert screen does not clear show-over-lock-screen (navigation state owns that)', async () => {
    const view = await render(<AlertDetailScreen />);
    await view.findByRole('button', { name: RESPONDING });
    view.unmount();

    expect(setShowWhenLocked).not.toHaveBeenCalledWith(false);
  });

  test('on an unlocked phone in use, opening the alert silences it', async () => {
    locked = false;
    const appState = AppState as unknown as { currentState: unknown };
    const original = appState.currentState;
    appState.currentState = 'active';
    const view = await render(<AlertDetailScreen />);
    await view.findByRole('button', { name: RESPONDING });
    await act(async () => {});
    appState.currentState = original;

    expect(notifee.cancelDisplayedNotification).toHaveBeenCalledWith(`dispatch:${dispatchId}`);
  });

  test('Silence stops the alarm without answering', async () => {
    const view = await render(<AlertDetailScreen />);
    await act(async () => {
      fireEvent.press(
        await view.findByRole('button', { name: 'Silence the alarm without answering' }),
      );
    });

    expect(notifee.cancelDisplayedNotification).toHaveBeenCalledWith(`dispatch:${dispatchId}`);
    expect(view.queryByText(/your response:/i)).toBeNull();
  });
});
