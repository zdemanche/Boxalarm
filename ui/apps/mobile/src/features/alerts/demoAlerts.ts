import { seedMockDispatch } from './mockAlertsRepository';
import type { RosterEntry } from './types';

export const DEMO_DISPATCH_ID = 'DEMO-STRUCTURE-1';

/**
 * One live call for the Simulator demo (auth/demoMode.tsx) - the same structure fire as the web
 * demo - so the page screen, roster and riding board can be seen without a backend. App.tsx calls
 * this only when isDemoMode(); the mock repository is otherwise empty until a self-test.
 */
export function seedDemoAlerts(now: number = Date.now()): void {
  const dispatchedAt = Math.floor(now / 1000) - 4 * 60;
  const member = (
    memberId: string,
    name: string,
    ackStatus: RosterEntry['ackStatus'],
    quals: string[],
    etaMinutes: number | null = null,
  ): RosterEntry => ({
    memberId,
    name,
    ackStatus,
    eta: etaMinutes === null ? null : dispatchedAt + etaMinutes * 60,
    assignedApparatusId: null,
    quals,
    lastAnsweredTone: ackStatus === 'UNANSWERED' ? null : 1,
  });

  seedMockDispatch(
    {
      dispatchId: DEMO_DISPATCH_ID,
      incidentType: 'Structure fire',
      address: '18 Nichols Ave',
      crossStreets: 'Main St & Nichols Ave',
      mapLink: null,
      narrative:
        'Caller reports smoke showing from the second floor, residential above a storefront. ' +
        'Occupants reported out of the building.',
      isSelfTest: false,
      dispatchedAt,
      toneLadder: {
        status: 'ACTIVE',
        currentToneSequence: 2,
        nextToneAt: new Date(now + 3 * 60_000).toISOString(),
        predicateGaps: ['Interior-qualified crew below minimum'],
      },
      mutualAid: null,
    },
    [
      member('MBR-0012', 'Jamie Rios', 'UNANSWERED', ['FF1', 'DRIVER_OPERATOR']),
      member('MBR-0003', 'Casey Nolan', 'RESPONDING', ['FF2', 'EMR'], 6),
      member('MBR-0007', 'Jordan Osei', 'DIRECT_TO_SCENE', ['FF1', 'INTERIOR'], 9),
      member('MBR-0019', 'Aisha Mensah', 'RESPONDING', ['FF1'], 11),
      member('MBR-0021', 'Chris Okafor', 'NOT_RESPONDING', ['FF1']),
    ],
  );
}
