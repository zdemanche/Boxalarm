import notifee, { EventType, type Event } from '@notifee/react-native';
import NetInfo from '@react-native-community/netinfo';
import { Platform } from 'react-native';
import { apiRequest } from '../../lib/apiClient';
import * as store from '../../sync/outboxStore';
import * as syncManager from '../../sync/syncManager';
import { getLocalAnswer } from './alertResponses';
import {
  answerFromActionId,
  handleNotificationEvent,
  IOS_DISPATCH_CATEGORY,
  registerNotificationCategories,
} from './notificationActions';

jest.mock('../../lib/apiClient', () => ({
  ...jest.requireActual('../../lib/apiClient'),
  apiRequest: jest.fn(),
}));

const mockApiRequest = apiRequest as jest.Mock;
const displayNotification = notifee.displayNotification as jest.Mock;
const tokens = { getAccessToken: jest.fn(), renewSilently: jest.fn() };

const pageData = {
  dispatchId: 'D-ACT',
  incidentType: 'Structure fire',
  address: '21 Main St',
  receivedAt: '1000',
  category: 'dispatch',
};

function actionPress(actionId: string): Event {
  return {
    type: EventType.ACTION_PRESS,
    detail: {
      pressAction: { id: actionId },
      notification: { id: 'dispatch:D-ACT', data: pageData },
    },
  } as Event;
}

beforeEach(async () => {
  const rows = await store.all();
  await Promise.all(rows.map((row) => store.remove(row.id)));
  mockApiRequest.mockReset();
  displayNotification.mockReset().mockResolvedValue(undefined);
  (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: true });
  syncManager.configure(tokens, 'https://api.example.com');
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('only the two response action ids map to answers', () => {
  expect(answerFromActionId('respond:RESPONDING')).toBe('RESPONDING');
  expect(answerFromActionId('respond:NOT_RESPONDING')).toBe('NOT_RESPONDING');
  expect(answerFromActionId('respond:DIRECT_TO_SCENE')).toBe('DIRECT_TO_SCENE');
  expect(answerFromActionId('respond:UNANSWERED')).toBeNull();
  expect(answerFromActionId('default')).toBeNull();
  expect(answerFromActionId(undefined)).toBeNull();
});

test('Responding from the notification goes through the outbox and the notification then says Sent', async () => {
  mockApiRequest.mockResolvedValue({ json: async () => ({}) });

  await handleNotificationEvent(actionPress('respond:RESPONDING'));

  expect(mockApiRequest).toHaveBeenCalledWith(
    'alerting/dispatches/D-ACT/responses',
    tokens,
    expect.objectContaining({ method: 'POST' }),
  );
  const body = JSON.parse(mockApiRequest.mock.calls[0]![2].body as string);
  expect(body).toMatchObject({ ackStatus: 'RESPONDING', assignedApparatusId: null });
  expect(body).toMatchObject({ eta: null, etaSource: 'NOT_GIVEN' });
  const last = displayNotification.mock.calls.at(-1)![0];
  expect(last.id).toBe('dispatch:D-ACT');
  expect(last.body).toMatch(/^Sent\./);
  // The replacement is quiet - it must not re-ring the page it answers.
  expect(last.android.channelId).toBe('notifications-default');
  await expect(getLocalAnswer('D-ACT')).resolves.toMatchObject({ ackStatus: 'RESPONDING' });
});

test('answering from the notification cancels the 60 s cap so it cannot overwrite the answer', async () => {
  mockApiRequest.mockResolvedValue({ json: async () => ({}) });
  const cancelTrigger = notifee.cancelTriggerNotification as jest.Mock;
  cancelTrigger.mockClear();

  await handleNotificationEvent(actionPress('respond:DIRECT_TO_SCENE'));

  expect(cancelTrigger).toHaveBeenCalledWith('dispatch:D-ACT');
  expect(JSON.parse(mockApiRequest.mock.calls[0]![2].body as string)).toMatchObject({
    ackStatus: 'DIRECT_TO_SCENE',
  });
});

test('with no signal the answer is kept on the phone and the notification says NOT SENT YET', async () => {
  (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: false });

  await handleNotificationEvent(actionPress('respond:NOT_RESPONDING'));

  expect(mockApiRequest).not.toHaveBeenCalled();
  expect(await store.all()).toEqual([
    expect.objectContaining({ kind: 'RESPONSE', status: 'QUEUED' }),
  ]);
  expect(displayNotification.mock.calls.at(-1)![0].body).toMatch(/NOT SENT YET/);
});

test('when the server says the roster did not take it, the notification says so - not "sent"', async () => {
  mockApiRequest.mockResolvedValue({ json: async () => ({ outcome: 'superseded' }) });

  await handleNotificationEvent(actionPress('respond:NOT_RESPONDING'));

  expect(displayNotification.mock.calls.at(-1)![0].body).toMatch(/NOT ON THE ROSTER/);
});

test('a plain press or an unknown action is ignored here (routing handles taps)', async () => {
  await handleNotificationEvent({
    type: EventType.PRESS,
    detail: { notification: { id: 'x', data: pageData } },
  } as Event);
  await handleNotificationEvent(actionPress('something-else'));

  expect(await store.all()).toHaveLength(0);
});

test('iOS registers the DISPATCH category with both answers', async () => {
  Platform.OS = 'ios';
  const setCategories = notifee.setNotificationCategories as jest.Mock;
  setCategories.mockClear();

  await registerNotificationCategories();

  expect(setCategories).toHaveBeenCalledWith([IOS_DISPATCH_CATEGORY]);
  expect(IOS_DISPATCH_CATEGORY.actions?.map((a) => a.id)).toEqual([
    'respond:RESPONDING',
    'respond:DIRECT_TO_SCENE',
    'respond:NOT_RESPONDING',
  ]);
});
