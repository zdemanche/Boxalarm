import * as store from '../../sync/outboxStore';
import { kvSet } from '../../sync/kvStore';
import { clearMemberCache } from '../../sync/memberCache';
import * as syncManager from '../../sync/syncManager';
import {
  ETA_CHOICES,
  etaFor,
  formatEta,
  getLocalAnswer,
  queueAlertResponse,
  responseBody,
} from './alertResponses';

test('an ETA is only ever one the member chose - no invented default', () => {
  expect(etaFor('RESPONDING', undefined)).toBeNull();
  expect(etaFor('RESPONDING', { minutes: 5, qualifier: null })).toEqual({
    minutes: 5,
    qualifier: null,
  });
  expect(etaFor('NOT_RESPONDING', { minutes: 5, qualifier: null })).toBeNull();
});

test('the chips are 5 / 10 / 15 / 20+ / At station', () => {
  expect(ETA_CHOICES.map((c) => c.label)).toEqual(['5', '10', '15', '20+', 'At station']);
});

test('an unchosen ETA reads "ETA ?"; 20+ and at-station read as such', () => {
  expect(formatEta(null)).toBe('ETA ?');
  expect(formatEta({ minutes: 20, qualifier: 'AT_LEAST' })).toBe('ETA 20+ min');
  expect(formatEta({ minutes: 0, qualifier: 'AT_STATION' })).toBe('At station');
});

test('a one-tap Responding sends eta null, marked NOT_GIVEN', () => {
  expect(responseBody('RESPONDING', null, 1_000_000, 'r-1')).toEqual({
    ackStatus: 'RESPONDING',
    eta: null,
    assignedApparatusId: null,
    etaSource: 'NOT_GIVEN',
    etaQualifier: null,
    clientAnswerId: 'r-1',
    answeredAtMs: 1_000_000,
  });
});

test('a chosen ETA is epoch seconds from the tap, with its qualifier', () => {
  expect(
    responseBody('DIRECT_TO_SCENE', { minutes: 20, qualifier: 'AT_LEAST' }, 1_000_000, 'r'),
  ).toMatchObject({ eta: 1_000 + 1_200, etaSource: 'MEMBER', etaQualifier: 'AT_LEAST' });
  expect(
    responseBody('RESPONDING', { minutes: 0, qualifier: 'AT_STATION' }, 1_000_000, 'r'),
  ).toMatchObject({ eta: 1_000, etaQualifier: 'AT_STATION' });
  expect(responseBody('NOT_RESPONDING', null, 1_000_000, 'r')).toMatchObject({
    eta: null,
    etaSource: null,
  });
});

test('queueing an answer puts it in the outbox and remembers it as this phone’s answer', async () => {
  const eta = { minutes: 15, qualifier: null };
  const id = await queueAlertResponse('D7', 'DIRECT_TO_SCENE', eta, 2_000_000);

  expect(await store.find(id)).toMatchObject({ kind: 'RESPONSE', status: 'QUEUED' });
  await expect(getLocalAnswer(null, 'D7')).resolves.toEqual({
    ackStatus: 'DIRECT_TO_SCENE',
    eta,
    outboxId: id,
    answeredAt: 2_000_000,
  });
});

test('an answer saved by the previous build ({ etaMinutes }) still reads back', async () => {
  await kvSet('alert-answer:MBR-1:OLD', {
    ackStatus: 'RESPONDING',
    etaMinutes: 10,
    outboxId: 'x',
    answeredAt: 1,
  });
  await expect(getLocalAnswer('MBR-1', 'OLD')).resolves.toMatchObject({
    eta: { minutes: 10, qualifier: null },
  });
});

test("M1: another member on this phone never sees the previous member's answer as theirs", async () => {
  syncManager.configure(
    { getAccessToken: async () => null, renewSilently: async () => null, memberId: 'A' },
    null,
  );
  await queueAlertResponse('D8', 'RESPONDING', null, 3_000_000);
  syncManager.configure(null, null);

  await expect(getLocalAnswer('A', 'D8')).resolves.toMatchObject({ ackStatus: 'RESPONDING' });
  await expect(getLocalAnswer('B', 'D8')).resolves.toBeNull();

  await clearMemberCache('A');
  await expect(getLocalAnswer('A', 'D8')).resolves.toBeNull();
});
