import type {
  AckStatus,
  AlertsRepository,
  DeliveryReceipt,
  DispatchAlert,
  ManualDispatchInput,
  RidingBoard,
  RosterEntry,
  SelfTestRun,
} from './types';

let selfTestCounter = 0;
let manualCounter = 0;
const DISPATCHES = new Map<string, DispatchAlert>();
const ROSTERS = new Map<string, RosterEntry[]>();
const SELF_TESTS = new Map<string, SelfTestRun>();
const RIDING_BOARDS = new Map<string, RidingBoard>();

// No backend access in every environment (offline / demo) - stands in for alerting-service's
// self-test, dispatch detail, roster and response round trips (F1.10, F1.6, F1.7). Self-test
// reuses the alert payload shape, so the mock returns a real DispatchAlert/RosterEntry rather
// than a special-cased "test" shape.
export const mockAlertsRepository: AlertsRepository = {
  async triggerSelfTest() {
    selfTestCounter += 1;
    const dispatchId = `SELFTEST-${selfTestCounter}`;
    const testId = `TEST-${selfTestCounter}`;

    DISPATCHES.set(dispatchId, {
      dispatchId,
      incidentType: 'Self-test',
      address: 'Your device',
      crossStreets: 'N/A',
      mapLink: null,
      narrative: 'This is a self-test alert. It confirms your phone can receive a real page.',
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
        lastAnsweredTone: null,
      },
    ]);

    SELF_TESTS.set(testId, {
      testId,
      runAt: Math.floor(Date.now() / 1000),
      channelsTested: ['PUSH', 'SMS'],
      channelResults: { PUSH: { ok: true, ms: 812 }, SMS: { ok: true, ms: 1340 } },
      overallResult: 'PASS',
    });

    return { testId, dispatchId };
  },

  async getSelfTestRun(testId) {
    const run = SELF_TESTS.get(testId);
    if (!run) throw new Error(`Unknown self-test run: ${testId}`);
    return run;
  },

  async getDispatch(dispatchId) {
    const dispatch = DISPATCHES.get(dispatchId);
    if (!dispatch) throw new Error(`Unknown dispatch: ${dispatchId}`);
    return dispatch;
  },

  async getRoster(dispatchId) {
    return ROSTERS.get(dispatchId) ?? [];
  },

  async submitResponse(dispatchId, ackStatus: AckStatus, etaMinutes) {
    const roster = ROSTERS.get(dispatchId);
    const entry = roster?.[0];
    if (entry) {
      entry.ackStatus = ackStatus;
      entry.eta = etaMinutes ? Math.floor(Date.now() / 1000) + etaMinutes * 60 : null;
      entry.lastAnsweredTone = 1;
    }

    const dispatch = DISPATCHES.get(dispatchId);
    if (dispatch?.toneLadder) {
      dispatch.toneLadder = { ...dispatch.toneLadder, status: 'COMPLETED', nextToneAt: null };
    }
  },

  async submitManualDispatch(input: ManualDispatchInput) {
    manualCounter += 1;
    const dispatchId = `MANUAL-${manualCounter}`;
    DISPATCHES.set(dispatchId, {
      dispatchId,
      incidentType: input.incidentType,
      address: input.address,
      crossStreets: input.crossStreets,
      mapLink: null,
      narrative: input.narrative,
      isSelfTest: false,
    });
    ROSTERS.set(dispatchId, []);
    return { dispatchId };
  },

  async getReceipts(): Promise<DeliveryReceipt[]> {
    return [];
  },

  async getRidingBoard(dispatchId) {
    const existing = RIDING_BOARDS.get(dispatchId);
    if (existing) return existing;

    // Nichols FD's real apparatus (tenant data, not to be hardcoded in screens/logic) - a
    // reasonable default board so the riding board is exercisable offline/pre-infra.
    const seeded: RidingBoard = {
      dispatchId,
      apparatus: [
        {
          apparatusId: 'a-301',
          unitId: 'Engine 301',
          type: 'Engine',
          status: 'IN_SERVICE',
          assignable: true,
          positions: [
            { code: 'OFF', label: 'Officer' },
            { code: 'DRIVER', label: 'Driver/Operator', requiredQual: 'DRIVER_OPERATOR' },
            { code: 'FF1', label: 'Firefighter' },
          ],
        },
        {
          apparatusId: 'a-309',
          unitId: 'Squad 309',
          type: 'Squad',
          status: 'OUT_OF_SERVICE',
          assignable: false,
          outOfServiceReason: 'Scheduled maintenance',
          positions: [{ code: 'DRIVER', label: 'Driver/Operator' }],
        },
      ],
    };
    RIDING_BOARDS.set(dispatchId, seeded);
    return seeded;
  },

  async assignRidingSeat(dispatchId, seat) {
    const board = RIDING_BOARDS.get(dispatchId) ?? { dispatchId, apparatus: [] };
    const unit = board.apparatus.find((a) => a.unitId === seat.unitId);
    if (!unit) {
      RIDING_BOARDS.set(dispatchId, board);
      return;
    }
    const position = unit.positions.find((p) => p.code === seat.positionCode);
    if (!position) return;
    position.assignment =
      seat.memberId === null
        ? undefined
        : {
            memberId: seat.memberId,
            version: seat.expectedVersion + 1,
            assignedAt: Math.floor(Date.now() / 1000),
            assignedBy: 'me',
            qualStatus: 'NO_REQUIREMENT',
          };
    RIDING_BOARDS.set(dispatchId, board);
  },
};
