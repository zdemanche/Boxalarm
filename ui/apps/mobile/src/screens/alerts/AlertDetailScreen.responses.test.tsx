import NetInfo from '@react-native-community/netinfo';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { NativeModules, Platform } from 'react-native';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { ApiError, apiRequest } from '../../lib/apiClient';
import { ConnectivityProvider } from '../../sync/ConnectivityContext';
import { kvDelete } from '../../sync/kvStore';
import * as store from '../../sync/outboxStore';
import * as syncManager from '../../sync/syncManager';
import { AlertDetailScreen } from './AlertDetailScreen';

// The API path: answers go through the SQLite outbox and the screen reports where they are.
jest.mock('../../lib/apiClient', () => ({
  ...jest.requireActual('../../lib/apiClient'),
  apiRequest: jest.fn(),
}));
jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));
jest.mock('react-native-config', () => ({ __esModule: true, default: { API_BASE_URL: '' } }));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
  useRoute: () => mockRoute,
}));

const mockRoute = {
  params: {
    dispatchId: 'D-1',
    payload: {
      dispatchId: 'D-1',
      incidentType: 'Structure fire',
      address: '21 Main St',
      receivedAt: Date.now(),
    },
  },
};

const mockApiRequest = apiRequest as jest.Mock;
const mockNetInfoFetch = NetInfo.fetch as jest.Mock;
const auth = {
  isAuthenticated: true,
  memberId: 'MBR-1',
  getAccessToken: jest.fn(),
  renewSilently: jest.fn(),
};

let postOutcome: (body: Record<string, unknown>) => Promise<unknown>;
let posted: Record<string, unknown>[];
let roster: { memberId: string; ackStatus: string; eta: number | null }[];

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  const rows = await store.all();
  await Promise.all(rows.map((row) => store.remove(row.id)));
  (Config as unknown as { API_BASE_URL: string }).API_BASE_URL = 'https://api.example.com';
  (useOptionalAuth as jest.Mock).mockReturnValue(auth);
  mockNetInfoFetch.mockResolvedValue({ isConnected: true });
  posted = [];
  roster = [];
  postOutcome = async () => ({ json: async () => ({}) });
  mockApiRequest.mockReset();
  mockApiRequest.mockImplementation(
    async (path: string, _tokens: unknown, init: { method?: string; body?: string }) => {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body!) as Record<string, unknown>;
        const response = await postOutcome(body);
        posted.push(body);
        return response;
      }
      if (path.endsWith('/roster')) return { json: async () => ({ members: roster }) };
      return {
        json: async () => ({
          dispatchId: 'D-1',
          incidentType: 'Structure fire',
          address: '21 Main St',
          crossStreets: '',
          mapLink: null,
          narrative: 'Smoke showing',
          prePlan: null,
        }),
      };
    },
  );
  syncManager.configure(auth, 'https://api.example.com');
  await flush();
});

async function renderScreen(isOnline = true) {
  const view = await render(
    <ConnectivityProvider initialIsOnline={isOnline}>
      <AlertDetailScreen />
    </ConnectivityProvider>,
  );
  await act(flush);
  return view;
}

/** Leaves the call and comes back to it: a fresh screen instance over the same phone storage. */
async function reopen(isOnline = true) {
  await act(async () => {
    screen.rerender(
      <ConnectivityProvider initialIsOnline={isOnline}>
        <AlertDetailScreen key={String(Math.random())} />
      </ConnectivityProvider>,
    );
  });
  await act(flush);
}

async function tap(name: string | RegExp) {
  await act(async () => {
    fireEvent.press(await screen.findByRole('button', { name }));
  });
  await act(flush);
}

async function answerResponding() {
  await tap(/^Responding — /);
  await act(async () => {
    fireEvent.press(await screen.findByRole('radio', { name: 'ETA 15 minutes' }));
  });
  await act(flush);
}

test('an answer the server accepted reads "Sent" and posts the ETA the member chose', async () => {
  await renderScreen();
  await answerResponding();

  expect(await screen.findByText('Sent')).toBeTruthy();
  // One tap sent Responding (default ETA); the chip sent the chosen ETA as a newer answer.
  expect(posted.at(-1)).toMatchObject({ ackStatus: 'RESPONDING', assignedApparatusId: null });
  const eta = posted.at(-1)!.eta as number;
  expect(eta - Math.floor(Date.now() / 1000)).toBeGreaterThan(14 * 60);
});

test('offline, the answer is kept on the phone and never shown as sent', async () => {
  mockNetInfoFetch.mockResolvedValue({ isConnected: false });
  await renderScreen(false);

  await tap(/^Not responding/);

  expect(await screen.findByText('Not sent yet')).toBeTruthy();
  expect(screen.queryByText('Sent')).toBeNull();
  expect(posted).toHaveLength(0);
  const rows = await store.all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: 'RESPONSE', status: 'QUEUED' });
});

test('a failed POST is not swallowed: it stays queued, says so, and delivers on retry', async () => {
  postOutcome = async () => {
    throw new TypeError('Network request failed');
  };
  await renderScreen();

  await tap(/^Not responding/);

  expect(await screen.findByText('Not sent yet')).toBeTruthy();
  expect(screen.getByText(/last attempt: network request failed/i)).toBeTruthy();

  postOutcome = async () => ({ json: async () => ({}) });
  await tap('Try sending your response now');

  expect(await screen.findByText('Sent')).toBeTruthy();
});

test('a refused answer is shown as refused with a way to send it again', async () => {
  postOutcome = async () => {
    throw new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403, traceId: 't' });
  };
  await renderScreen();

  await tap(/^Not responding/);

  expect(await screen.findByText('Refused by server')).toBeTruthy();
  expect(
    await screen.findByRole('button', { name: 'Send my answer again: Not responding' }),
  ).toBeTruthy();
});

test('changing the answer sends the new one and drops the older one still waiting to send', async () => {
  mockNetInfoFetch.mockResolvedValue({ isConnected: false });
  await renderScreen(false);

  await tap(/^Not responding/);
  await answerResponding();

  const rows = await store.all();
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0]!.body)).toMatchObject({ ackStatus: 'RESPONDING' });
  expect(await screen.findByText(/your response: responding/i)).toBeTruthy();
});

test('when the roster disagrees with an answer given here earlier, both are shown - never silently swapped (review CR-3)', async () => {
  await renderScreen();
  await tap(/^Not responding/);
  expect(await screen.findByText('Sent')).toBeTruthy();

  roster = [{ memberId: 'MBR-1', ackStatus: 'RESPONDING', eta: null }];
  await reopen();

  expect(await screen.findByText('Roster shows something else')).toBeTruthy();
  expect(
    screen.getByText(
      /roster shows: responding, eta \?\. your last answer from this phone: not responding/i,
    ),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send my answer again: Not responding' })).toBeTruthy();

  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Keep what the roster shows: Responding' }));
  });
  await act(flush);
  expect(await screen.findByText(/your response: responding/i)).toBeTruthy();
  expect(screen.getByText('Sent')).toBeTruthy();
});

test('after an answer is delivered the roster is read back; a change the roster did not take is flagged (review CR-3)', async () => {
  roster = [{ memberId: 'MBR-1', ackStatus: 'RESPONDING', eta: null }];
  await renderScreen();
  await tap(/^Not responding/); // server answers 200, roster still says Responding

  expect(
    await screen.findByText('Roster shows something else', {}, { timeout: 4_000 }),
  ).toBeTruthy();
});

test('a 409 SUPERSEDED reads "Newer answer on the roster", shows the roster answer, and offers send-again or keep', async () => {
  roster = [];
  postOutcome = async () => {
    roster = [{ memberId: 'MBR-1', ackStatus: 'RESPONDING', eta: null }];
    throw new ApiError({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      traceId: 't',
      code: 'SUPERSEDED',
    } as never);
  };
  await renderScreen();

  await tap(/^Not responding/);

  expect(await screen.findByText('Newer answer on the roster')).toBeTruthy();
  expect(await screen.findByText(/roster shows: responding/i)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send my answer again: Not responding' })).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Keep what the roster shows: Responding' }),
  ).toBeTruthy();
});

test('a 409 from the server reads "Not on the roster" with a resend', async () => {
  postOutcome = async () => {
    throw new ApiError({ type: 'about:blank', title: 'Conflict', status: 409, traceId: 't' });
  };
  await renderScreen();

  await tap(/^Not responding/);

  expect(await screen.findByText('Not on the roster')).toBeTruthy();
  expect(
    await screen.findByRole('button', { name: 'Send my answer again: Not responding' }),
  ).toBeTruthy();
});

test('a 401 reads as a sign-in problem, not as no signal (review m9)', async () => {
  postOutcome = async () => {
    throw new ApiError({ type: 'about:blank', title: 'Unauthorized', status: 401, traceId: 't' });
  };
  await renderScreen();

  await tap(/^Not responding/);

  expect(await screen.findByText('Not sent - sign-in problem')).toBeTruthy();
});

test('one tap sends eta null; the member sees "ETA ?" whether the server accepts null or needs the placeholder', async () => {
  await renderScreen();
  await tap(/^Responding — /);
  expect(await screen.findByText('Sent')).toBeTruthy();
  expect(posted.at(-1)).toMatchObject({ eta: null, etaSource: 'NOT_GIVEN' });
  expect(screen.getByText(/your response: responding · eta \?/i)).toBeTruthy();
});

test('against a server that still requires an ETA, the answer is re-sent with the flagged placeholder and still reads "ETA ?"', async () => {
  let first = true;
  postOutcome = async (body) => {
    if (first && body.eta === null) {
      first = false;
      throw new ApiError({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'eta is required and must be a positive integer for this ackStatus',
        traceId: 't',
      });
    }
    return { json: async () => ({}) };
  };
  await renderScreen();
  await tap(/^Responding — /);

  expect(await screen.findByText('Sent')).toBeTruthy();
  expect(posted.at(-1)).toMatchObject({ etaSource: 'NOT_GIVEN' });
  expect(typeof posted.at(-1)!.eta).toBe('number');
  expect(screen.getByText(/your response: responding · eta \?/i)).toBeTruthy();
});

test('a roster answer of At station reads back as "At station", not "ETA 0 min" (round 2 m2-5)', async () => {
  await kvDelete('alert-answer:D-1');
  roster = [{ memberId: 'MBR-1', ackStatus: 'RESPONDING', eta: Math.floor(Date.now() / 1000) }];
  await renderScreen();

  expect(await screen.findByText(/your response: responding · at station/i)).toBeTruthy();
  expect(screen.queryByText(/eta 0 min/i)).toBeNull();
});

test('each answer carries a clientAnswerId and answeredAtMs', async () => {
  await renderScreen();
  await tap(/^Not responding/);

  // A UUID, never derived from the dispatchId, always inside the server's pattern (round 2 C-2).
  expect(posted[0]).toMatchObject({
    clientAnswerId: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  });
  expect(posted[0]!.clientAnswerId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  expect(typeof posted[0]!.answeredAtMs).toBe('number');
});

test('re-opening the call shows the answer already given, with its delivery state', async () => {
  await renderScreen();
  await answerResponding();
  expect(await screen.findByText('Sent')).toBeTruthy();

  await reopen();

  expect(await screen.findByText(/your response: responding/i)).toBeTruthy();
  expect(screen.getByText('Sent')).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Responding — /, selected: true })).toBeTruthy();
});

test('with no answer on this phone, the server roster seeds the member’s own answer', async () => {
  await kvDelete('alert-answer:D-1');
  roster = [{ memberId: 'MBR-1', ackStatus: 'DIRECT_TO_SCENE', eta: null }];
  await renderScreen();

  expect(await screen.findByText(/your response: direct to scene/i)).toBeTruthy();
  expect(screen.getByText('Sent')).toBeTruthy();
});

describe('lock screen after answering (round 2 m2-2)', () => {
  const nativeModules = NativeModules as { BoxalarmAlertReadiness?: unknown };
  let setShowWhenLocked: jest.Mock;

  beforeEach(async () => {
    // A fresh call: no answer left on the phone by an earlier test.
    await kvDelete('alert-answer:D-1');
    Platform.OS = 'android';
    setShowWhenLocked = jest.fn();
    nativeModules.BoxalarmAlertReadiness = {
      isKeyguardLocked: jest.fn(async () => true),
      setShowWhenLocked,
    };
  });

  afterEach(() => {
    delete nativeModules.BoxalarmAlertReadiness;
    Platform.OS = 'ios';
  });

  test('once the answer is sent, the alert stops showing over the keyguard', async () => {
    await renderScreen();
    expect(setShowWhenLocked).toHaveBeenLastCalledWith(true);

    await tap(/^Not responding/);
    expect(await screen.findByText('Sent')).toBeTruthy();

    expect(setShowWhenLocked).toHaveBeenLastCalledWith(false);
  });

  test('an answer that is not sent yet keeps the alert over the keyguard (its warning must stay visible)', async () => {
    mockNetInfoFetch.mockResolvedValue({ isConnected: false });
    await renderScreen(false);

    await tap(/^Not responding/);
    expect(await screen.findByText('Not sent yet')).toBeTruthy();

    expect(setShowWhenLocked).not.toHaveBeenCalledWith(false);
  });
});
