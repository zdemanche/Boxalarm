import type { AckStatus, AlertsRepository, DispatchAlert, RosterEntry } from './types';

let selfTestCounter = 0;
const DISPATCHES = new Map<string, DispatchAlert>();
const ROSTERS = new Map<string, RosterEntry[]>();

// No backend access yet - stands in for alerting-service's POST /self-test + GET /dispatches/{id}
// round trip (F1.10). Self-test reuses the alert payload shape, so the mock returns a real
// DispatchAlert/RosterEntry rather than a special-cased "test" shape.
export const mockAlertsRepository: AlertsRepository = {
  async triggerSelfTest() {
    selfTestCounter += 1;
    const dispatchId = `SELFTEST-${selfTestCounter}`;

    DISPATCHES.set(dispatchId, {
      dispatchId,
      type: 'Self-test',
      address: 'Your device',
      notes: 'This is a self-test alert. It confirms your phone can receive a real page.',
      isSelfTest: true,
      toneLadder: {
        status: 'ACTIVE',
        currentToneSequence: 1,
        nextToneAt: new Date(Date.now() + 60_000).toISOString(),
        predicateGaps: ['Awaiting your response'],
      },
    });

    ROSTERS.set(dispatchId, [
      {
        memberId: 'MBR-0012',
        name: 'Jamie Rios',
        ackStatus: 'UNANSWERED',
        eta: null,
        assignedApparatusId: null,
        quals: ['FF1', 'DRIVER_OPERATOR'],
        currentChannelTier: 1,
        lastAnsweredTone: null,
      },
    ]);

    return { testId: `TEST-${selfTestCounter}`, dispatchId, status: 'DELIVERED' };
  },

  async getDispatch(dispatchId) {
    const dispatch = DISPATCHES.get(dispatchId);
    if (!dispatch) throw new Error(`Unknown dispatch: ${dispatchId}`);
    return dispatch;
  },

  async getRoster(dispatchId) {
    return ROSTERS.get(dispatchId) ?? [];
  },

  async submitResponse(dispatchId, ackStatus: AckStatus, eta) {
    const roster = ROSTERS.get(dispatchId);
    const entry = roster?.[0];
    if (entry) {
      entry.ackStatus = ackStatus;
      entry.eta = eta ?? null;
      entry.lastAnsweredTone = entry.currentChannelTier;
    }

    const dispatch = DISPATCHES.get(dispatchId);
    if (dispatch) {
      dispatch.toneLadder = { ...dispatch.toneLadder, status: 'COMPLETED', nextToneAt: null };
    }
  },
};
