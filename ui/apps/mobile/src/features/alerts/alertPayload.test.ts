import {
  alertPayloadFromNotificationData,
  alertPayloadFromPushData,
  alertPayloadToNotificationData,
  cachedAlertPayload,
  rememberAlertPayload,
} from './alertPayload';

test('reads the address out of the body the alerting service sends today ("{type} — {address}")', () => {
  const payload = alertPayloadFromPushData(
    {
      dispatchId: 'D1',
      title: 'Structure fire',
      body: 'Structure fire — 21 Main St',
      toneSequence: '2',
    },
    1_000,
  );
  expect(payload).toEqual({
    dispatchId: 'D1',
    incidentType: 'Structure fire',
    address: '21 Main St',
    toneSequence: 2,
    receivedAt: 1_000,
  });
});

test('explicit incidentType/address/crossStreets/dispatchedAt keys win over the body', () => {
  const payload = alertPayloadFromPushData(
    {
      dispatchId: 'D1',
      title: 'STRUCTURE FIRE · TONE 2',
      body: 'whatever',
      incidentType: 'Structure fire',
      address: '21 Main St',
      crossStreets: 'Elm / Oak',
      dispatchedAt: '1700000000',
    },
    5,
  );
  expect(payload).toMatchObject({
    incidentType: 'Structure fire',
    address: '21 Main St',
    crossStreets: 'Elm / Oak',
    dispatchedAt: 1_700_000_000_000,
    receivedAt: 5,
  });
});

test('no dispatchId means there is nothing to open', () => {
  expect(alertPayloadFromPushData({ title: 'x' }, 1)).toBeNull();
  expect(alertPayloadFromPushData(undefined, 1)).toBeNull();
});

test('a payload round-trips through the notification data map (strings only)', () => {
  const payload = {
    dispatchedAt: 1_700_000_000_000,
    dispatchId: 'D1',
    incidentType: 'MVA',
    address: '1 Main St',
    crossStreets: 'Elm',
    toneSequence: 3,
    receivedAt: 42,
  };
  const data = alertPayloadToNotificationData(payload);
  expect(Object.values(data).every((value) => typeof value === 'string')).toBe(true);
  expect(alertPayloadFromNotificationData(data)).toEqual(payload);
});

test('a later tone of the same call keeps the first receipt time', async () => {
  await rememberAlertPayload({
    dispatchId: 'D9',
    incidentType: 'MVA',
    address: '1 Main St',
    receivedAt: 100,
  });
  await rememberAlertPayload({
    dispatchId: 'D9',
    incidentType: 'MVA',
    address: '1 Main St',
    toneSequence: 2,
    receivedAt: 500,
  });
  await expect(cachedAlertPayload('D9')).resolves.toMatchObject({
    receivedAt: 100,
    toneSequence: 2,
  });
});
