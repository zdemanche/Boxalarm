import { mockAlertsRepository } from './mockAlertsRepository';

test('triggerSelfTest resolves a testId and dispatch id', async () => {
  const result = await mockAlertsRepository.triggerSelfTest();
  expect(result.testId).toBeTruthy();
  expect(result.dispatchId).toBeTruthy();
});

test('getSelfTestRun resolves per-channel results, never a bare ok', async () => {
  const { testId } = await mockAlertsRepository.triggerSelfTest();
  const run = await mockAlertsRepository.getSelfTestRun(testId);
  expect(run.overallResult).toBe('PASS');
  expect(run.channelResults.PUSH?.ok).toBe(true);
  expect(run.channelsTested).toEqual(['PUSH', 'SMS']);
});

test('getDispatch resolves the self-test dispatch by id', async () => {
  const { dispatchId } = await mockAlertsRepository.triggerSelfTest();
  const dispatch = await mockAlertsRepository.getDispatch(dispatchId);
  expect(dispatch.isSelfTest).toBe(true);
  expect(dispatch.dispatchId).toBe(dispatchId);
});

test('getRoster resolves a roster containing only the calling member', async () => {
  const { dispatchId } = await mockAlertsRepository.triggerSelfTest();
  const roster = await mockAlertsRepository.getRoster(dispatchId);
  expect(roster).toHaveLength(1);
  expect(roster[0]?.ackStatus).toBe('UNANSWERED');
});

test('submitResponse updates the roster entry, converts ETA minutes to epoch seconds, and completes the tone ladder', async () => {
  const { dispatchId } = await mockAlertsRepository.triggerSelfTest();
  const before = Math.floor(Date.now() / 1000);
  await mockAlertsRepository.submitResponse(dispatchId, 'RESPONDING', 15);

  const roster = await mockAlertsRepository.getRoster(dispatchId);
  expect(roster[0]?.ackStatus).toBe('RESPONDING');
  expect(roster[0]?.eta).toBeGreaterThanOrEqual(before + 15 * 60 - 5);

  const dispatch = await mockAlertsRepository.getDispatch(dispatchId);
  expect(dispatch.toneLadder?.status).toBe('COMPLETED');
});

test('submitManualDispatch creates a real, retrievable dispatch', async () => {
  const { dispatchId } = await mockAlertsRepository.submitManualDispatch({
    incidentType: 'Structure fire',
    address: '12 Elm St',
    crossStreets: 'Main & Elm',
    unitsRequested: ['Engine 301'],
    narrative: 'Smoke showing',
    externalDispatchId: 'ext-1',
  });

  const dispatch = await mockAlertsRepository.getDispatch(dispatchId);
  expect(dispatch.incidentType).toBe('Structure fire');
  expect(dispatch.isSelfTest).toBe(false);
});

test('assignRidingSeat records an assignment the riding board then returns', async () => {
  const { dispatchId } = await mockAlertsRepository.submitManualDispatch({
    incidentType: 'MVA',
    address: '1 Main St',
    crossStreets: 'N/A',
    unitsRequested: [],
    narrative: '',
    externalDispatchId: 'ext-2',
  });

  await mockAlertsRepository.assignRidingSeat(dispatchId, {
    unitId: 'Engine 301',
    positionCode: 'OFF',
    memberId: 'MBR-0012',
    expectedVersion: 0,
  });

  const board = await mockAlertsRepository.getRidingBoard(dispatchId);
  expect(board.dispatchId).toBe(dispatchId);
});
