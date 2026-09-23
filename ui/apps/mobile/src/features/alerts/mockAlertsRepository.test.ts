import { mockAlertsRepository } from './mockAlertsRepository';

test('triggerSelfTest resolves a delivered result with a dispatch id', async () => {
  const result = await mockAlertsRepository.triggerSelfTest();
  expect(result.status).toBe('DELIVERED');
  expect(result.dispatchId).toBeTruthy();
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

test('submitResponse updates the roster entry and completes the tone ladder', async () => {
  const { dispatchId } = await mockAlertsRepository.triggerSelfTest();
  await mockAlertsRepository.submitResponse(dispatchId, 'RESPONDING', '2026-09-13T15:00:00Z');

  const roster = await mockAlertsRepository.getRoster(dispatchId);
  expect(roster[0]?.ackStatus).toBe('RESPONDING');
  expect(roster[0]?.eta).toBe('2026-09-13T15:00:00Z');

  const dispatch = await mockAlertsRepository.getDispatch(dispatchId);
  expect(dispatch.toneLadder.status).toBe('COMPLETED');
});
