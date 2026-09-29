import {
  DEFAULT_ETA_MINUTES,
  etaFor,
  getLocalAnswer,
  queueAlertResponse,
  responseBody,
} from './alertResponses';
import * as store from '../../sync/outboxStore';

test('Responding and Direct to scene always carry an ETA - the server rejects them without one', () => {
  expect(etaFor('RESPONDING', undefined)).toBe(DEFAULT_ETA_MINUTES);
  expect(etaFor('DIRECT_TO_SCENE', 0)).toBe(DEFAULT_ETA_MINUTES);
  expect(etaFor('RESPONDING', 5)).toBe(5);
  expect(etaFor('NOT_RESPONDING', 5)).toBeNull();
});

test('the body carries the ETA as epoch seconds from the moment the member answered', () => {
  expect(responseBody('RESPONDING', 10, 1_000_000, 'r-1')).toEqual({
    ackStatus: 'RESPONDING',
    eta: 1_000 + 600,
    assignedApparatusId: null,
    clientAnswerId: 'r-1',
    answeredAtMs: 1_000_000,
  });
  expect(responseBody('NOT_RESPONDING', null, 1_000_000, 'r-2')).toMatchObject({
    ackStatus: 'NOT_RESPONDING',
    eta: null,
    clientAnswerId: 'r-2',
    answeredAtMs: 1_000_000,
  });
});

test('queueing an answer puts it in the outbox and remembers it as this phone’s answer', async () => {
  const id = await queueAlertResponse('D7', 'DIRECT_TO_SCENE', 15, 2_000_000);

  expect(await store.find(id)).toMatchObject({ kind: 'RESPONSE', status: 'QUEUED' });
  await expect(getLocalAnswer('D7')).resolves.toEqual({
    ackStatus: 'DIRECT_TO_SCENE',
    etaMinutes: 15,
    outboxId: id,
    answeredAt: 2_000_000,
  });
});
