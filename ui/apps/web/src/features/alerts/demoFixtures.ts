import {
  DEMO_DRIVER_MEMBER_IDS,
  DEMO_FLEET,
  DEMO_INTERIOR_MEMBER_IDS,
  DEMO_MEMBER_BY_ID,
  DEMO_RESPONDING_MEMBER_IDS,
  demoMemberName,
} from '../../lib/demoRoster';
import type {
  ActiveDispatchList,
  CanaryRun,
  CanaryStatus,
  DeliveryReceipt,
  DeviceState,
  DiagnosticsResult,
  DiagnosticsTimelineEntry,
  DispatchAlert,
  ManualDispatchInput,
  RidingBoard,
  RidingBoardApparatus,
  RidingSeatPosition,
  RosterEntry,
  AckStatus,
} from './types';

/*
 * Demo-mode alerting plane for Nichols FD. Everything here is fixture data keyed on the shared
 * roster (lib/demoRoster.ts) and fleet, with every timestamp relative to module load so a demo
 * opened next month still shows "dispatched 12 minutes ago". There is no randomness: the same
 * member always answers the same tone with the same receipts, so a walkthrough is repeatable.
 *
 * The write paths (manual dispatch, tone-ladder and mutual-aid controls, riding-board seats)
 * mirror alerting-service's preconditions and 409 bodies and are exercised by unit tests and
 * e2e - keep their behaviour when touching the seed data.
 */

const NOW = Math.floor(Date.now() / 1000);
const MINUTE = 60;
const HOUR = 60 * MINUTE;

let dispatchCounter = 0;
const DISPATCHES = new Map<string, DispatchAlert>();
const ROSTERS = new Map<string, RosterEntry[]>();
const RECEIPTS = new Map<string, DeliveryReceipt[]>();
const RIDING_BOARDS = new Map<string, RidingBoard>();
/** Escalation bookkeeping per dispatch, surfaced on the diagnostics timeline only. */
const ESCALATIONS = new Map<
  string,
  { toneSequence: number; escalatedAt: number; reason: string }[]
>();
/** Epoch seconds each demo dispatch went out — drives the active-dispatch list. */
const DISPATCHED_AT = new Map<string, number>();
const DEMO_ACTIVE_WINDOW_SECONDS = 2 * HOUR;

/** Seconds between automatic tones when too few members have acknowledged (ALERT_RULES N=90). */
const TONE_GAP_SECONDS = 3 * MINUTE;
const FINAL_TONE = 3;

// ---------------------------------------------------------------------------------------------
// Qualifications and device state per member (derived from the shared roster)
// ---------------------------------------------------------------------------------------------

const OFFICER_RANKS = new Set([
  'Chief',
  'Deputy Chief',
  'Assistant Chief',
  'Captain',
  'Lieutenant',
  'Safety Officer',
]);

/** FF2 holders: every other interior member, so the riding board has both FF1-only and FF2 crews. */
const FF2_MEMBER_IDS = new Set(DEMO_INTERIOR_MEMBER_IDS.filter((_, index) => index % 2 === 0));

function qualsFor(memberId: string): string[] {
  const member = DEMO_MEMBER_BY_ID.get(memberId);
  if (!member) return [];
  const quals: string[] = [];
  if (member.rank === 'Fire Police') return ['FIRE_POLICE', 'TRAFFIC_CONTROL'];
  if (member.rank === 'Administrative Member') return [];
  if (member.status === 'ACTIVE') quals.push('FF1');
  if (FF2_MEMBER_IDS.has(memberId)) quals.push('FF2');
  if (member.status === 'ACTIVE') quals.push('HAZMAT_OPS');
  if (DEMO_DRIVER_MEMBER_IDS.includes(memberId)) quals.push('DRIVER_OPERATOR');
  if (OFFICER_RANKS.has(member.rank)) quals.push('OFFICER');
  if (member.rank === 'Safety Officer') quals.push('SAFETY_OFFICER');
  return quals;
}

/**
 * Device-state reports for every responding member. A handful are deliberately unhealthy so
 * Alert diagnostics has something to explain: m-8 and m-11 never granted critical alerts,
 * m-19 and m-28 are Android installs still under battery optimization, m-27 turned
 * notifications off.
 */
const DEVICE_STATES = new Map<string, DeviceState>(
  DEMO_RESPONDING_MEMBER_IDS.map((memberId, index) => {
    const android = index % 3 === 1;
    const appVersion = index % 5 === 0 ? '1.3.2' : index % 2 === 0 ? '1.4.1' : '1.4.0';
    return [
      memberId,
      {
        memberId,
        notificationPermission: memberId !== 'm-27',
        criticalAlertPermission: !['m-8', 'm-11', 'm-27'].includes(memberId),
        batteryOptimizationExempt: !android || !['m-19', 'm-28'].includes(memberId),
        appVersion,
        osVersion: android ? (index % 2 === 0 ? 'Android 15' : 'Android 14') : 'iOS 18.1',
        reportedAt: NOW - (20 * MINUTE + index * 37 * MINUTE),
      },
    ];
  }),
);

// ---------------------------------------------------------------------------------------------
// Roster + receipts
// ---------------------------------------------------------------------------------------------

/** How one member reacted to a page: the tone they answered on and what they said. */
interface Reaction {
  ackStatus: AckStatus;
  /** Which tone they answered on (null for UNANSWERED). */
  tone: number | null;
  /** Minutes from dispatch to arrival at the station or the scene (RESPONDING / DIRECT only). */
  etaMinutes?: number;
  assignedApparatusId?: string;
}

/** Per-member delivery trouble on this dispatch, so receipts and diagnostics line up. */
interface DeliveryFault {
  pushFailure?: string;
  smsFailure?: string;
  /** Push accepted by the provider but the device never confirmed (app killed, no network). */
  pushUnconfirmed?: boolean;
}

interface DispatchSeed {
  dispatch: Omit<DispatchAlert, 'dispatchId' | 'toneLadder' | 'mutualAid'>;
  dispatchedAt: number;
  /** Tones that have fired (1..3). */
  tonesFired: number;
  ladderStatus: 'ACTIVE' | 'HALTED_MANUAL' | 'COMPLETED';
  /** Whether a further automatic tone is still scheduled (ACTIVE ladders only). */
  nextToneScheduled: boolean;
  reactions: Record<string, Reaction>;
  faults: Record<string, DeliveryFault>;
  /** Pre-assigned riding-board seats: unitId -> position code -> memberId. */
  seats: Record<string, Record<string, string>>;
  outOfService: Record<string, string>;
}

function rosterFor(seed: Pick<DispatchSeed, 'reactions' | 'dispatchedAt'>): RosterEntry[] {
  return DEMO_RESPONDING_MEMBER_IDS.map((memberId) => {
    const reaction = seed.reactions[memberId] ?? { ackStatus: 'UNANSWERED', tone: null };
    const eta =
      reaction.etaMinutes !== undefined ? seed.dispatchedAt + reaction.etaMinutes * MINUTE : null;
    return {
      memberId,
      name: demoMemberName(memberId),
      ackStatus: reaction.ackStatus,
      eta,
      assignedApparatusId: reaction.assignedApparatusId ?? null,
      quals: qualsFor(memberId),
      lastAnsweredTone: reaction.tone,
    };
  });
}

/**
 * One immutable receipt per channel attempt per tone (exactly-once key
 * {dispatchId}#{toneSequence}#{memberId}#{channel}). Tone 1 goes out as push + SMS; tones 2 and
 * 3 add a voice call. Sends are staggered a few seconds apart the way the fan-out really lands.
 */
function receiptsFor(
  seed: Pick<DispatchSeed, 'reactions' | 'faults' | 'dispatchedAt' | 'tonesFired'>,
): DeliveryReceipt[] {
  const receipts: DeliveryReceipt[] = [];
  for (let tone = 1; tone <= seed.tonesFired; tone += 1) {
    const toneAt = seed.dispatchedAt + (tone - 1) * TONE_GAP_SECONDS;
    DEMO_RESPONDING_MEMBER_IDS.forEach((memberId, index) => {
      const reaction = seed.reactions[memberId] ?? { ackStatus: 'UNANSWERED', tone: null };
      const fault = seed.faults[memberId] ?? {};
      const sentAt = toneAt + 1 + (index % 7);
      const answeredThisTone = reaction.tone === tone;
      const openedAt = answeredThisTone ? sentAt + 12 + (index % 5) * 9 : null;

      const push: DeliveryReceipt = fault.pushFailure
        ? {
            memberId,
            channel: 'PUSH',
            toneSequence: tone,
            status: 'FAILED',
            sentAt,
            deliveredAt: null,
            openedAt: null,
            failureReason: fault.pushFailure,
          }
        : fault.pushUnconfirmed
          ? {
              memberId,
              channel: 'PUSH',
              toneSequence: tone,
              status: 'SENT_UNCONFIRMED',
              sentAt,
              deliveredAt: null,
              openedAt: null,
              failureReason: null,
            }
          : {
              memberId,
              channel: 'PUSH',
              toneSequence: tone,
              status: openedAt ? 'OPENED' : 'DELIVERED',
              sentAt,
              deliveredAt: sentAt + 2 + (index % 3),
              openedAt,
              failureReason: null,
            };
      receipts.push(push);

      receipts.push(
        fault.smsFailure
          ? {
              memberId,
              channel: 'SMS',
              toneSequence: tone,
              status: 'FAILED',
              sentAt: sentAt + 1,
              deliveredAt: null,
              openedAt: null,
              failureReason: fault.smsFailure,
            }
          : {
              memberId,
              channel: 'SMS',
              toneSequence: tone,
              status: 'DELIVERED',
              sentAt: sentAt + 1,
              deliveredAt: sentAt + 4 + (index % 4),
              openedAt: null,
              failureReason: null,
            },
      );

      if (tone >= 2) {
        // Voice is answered only by members who acknowledged on this tone; everyone else rang
        // through to voicemail, which the provider reports as sent but unconfirmed.
        receipts.push({
          memberId,
          channel: 'VOICE',
          toneSequence: tone,
          status: answeredThisTone ? 'DELIVERED' : 'SENT_UNCONFIRMED',
          sentAt: sentAt + 3,
          deliveredAt: answeredThisTone ? sentAt + 9 + (index % 6) : null,
          openedAt: null,
          failureReason: null,
        });
      }
    });
  }
  return receipts;
}

// ---------------------------------------------------------------------------------------------
// Riding board (the real fleet, as named everywhere else in the demo)
// ---------------------------------------------------------------------------------------------

const DRIVER: RidingSeatPosition = {
  code: 'DRIVER',
  label: 'Driver/Operator',
  requiredQual: 'DRIVER_OPERATOR',
};
const OFFICER: RidingSeatPosition = { code: 'OFF', label: 'Officer', requiredQual: 'OFFICER' };

const POSITIONS_BY_TYPE: Record<string, RidingSeatPosition[]> = {
  Engine: [
    OFFICER,
    DRIVER,
    { code: 'NOZZLE', label: 'Nozzle', requiredQual: 'FF1' },
    { code: 'BACKUP', label: 'Backup', requiredQual: 'FF1' },
    { code: 'HYDRANT', label: 'Hydrant' },
  ],
  Ladder: [
    OFFICER,
    DRIVER,
    { code: 'OV', label: 'Outside vent', requiredQual: 'FF2' },
    { code: 'IRONS', label: 'Irons', requiredQual: 'FF1' },
  ],
  Rescue: [
    OFFICER,
    DRIVER,
    { code: 'FF1', label: 'Firefighter (search)', requiredQual: 'FF1' },
    { code: 'FF2', label: 'Firefighter (tools)', requiredQual: 'FF1' },
  ],
  Squad: [DRIVER, { code: 'FF1', label: 'Firefighter', requiredQual: 'FF1' }],
  Utility: [DRIVER, { code: 'FF1', label: 'Firefighter' }],
  Brush: [DRIVER, { code: 'FF1', label: 'Firefighter', requiredQual: 'FF1' }],
};

function clonePositions(type: string): RidingSeatPosition[] {
  return (POSITIONS_BY_TYPE[type] ?? [DRIVER]).map((position) => ({ ...position }));
}

function seatQualStatus(
  memberId: string,
  position: RidingSeatPosition,
): 'MET' | 'UNMET' | 'NO_REQUIREMENT' {
  if (!position.requiredQual) return 'NO_REQUIREMENT';
  return qualsFor(memberId).includes(position.requiredQual) ? 'MET' : 'UNMET';
}

function ridingBoardFor(
  dispatchId: string,
  seed: Pick<DispatchSeed, 'seats' | 'outOfService' | 'dispatchedAt'>,
): RidingBoard {
  const apparatus: RidingBoardApparatus[] = DEMO_FLEET.map((unit) => {
    const outOfServiceReason = seed.outOfService[unit.unitId];
    const positions = clonePositions(unit.type);
    const assigned = seed.seats[unit.unitId] ?? {};
    for (const position of positions) {
      const memberId = assigned[position.code];
      if (!memberId) continue;
      position.assignment = {
        memberId,
        version: 1,
        assignedAt: seed.dispatchedAt + 4 * MINUTE + positions.indexOf(position) * 20,
        assignedBy: 'm-9',
        qualStatus: seatQualStatus(memberId, position),
      };
    }
    return {
      apparatusId: unit.apparatusId,
      unitId: unit.unitId,
      type: unit.type,
      status: outOfServiceReason ? 'OUT_OF_SERVICE' : 'IN_SERVICE',
      assignable: !outOfServiceReason,
      ...(outOfServiceReason ? { outOfServiceReason } : {}),
      positions,
    };
  });
  return { dispatchId, apparatus };
}

// ---------------------------------------------------------------------------------------------
// The seeded calls: one active structure fire, plus history for the dispatch header/list
// ---------------------------------------------------------------------------------------------

/** Truck 304 has been down two days (apparatus fixtures carry the same reason and clock). */
const FLEET_STATUS_TODAY: Record<string, string> = { 'Truck 304': 'Aerial hydraulic leak' };

const DEMO_ACTIVE_DISPATCH_ID = 'NICHOLS-DEMO-1';

const SEEDS: Record<string, DispatchSeed> = {
  // Dispatched 12 minutes ago. Tone 1 drew too few acknowledgements inside 90 s, so tone 2 fired
  // automatically at +3:00 and brought the crews up to a full first-alarm turnout; tone 3 is
  // still scheduled in case the officer wants it.
  [DEMO_ACTIVE_DISPATCH_ID]: {
    dispatchedAt: NOW - 12 * MINUTE,
    tonesFired: 2,
    ladderStatus: 'ACTIVE',
    nextToneScheduled: true,
    dispatch: {
      incidentType: 'Structure fire',
      address: '18 Nichols Ave',
      crossStreets: 'Main St & Nichols Ave',
      mapLink: null,
      narrative:
        'Caller reports smoke showing from the second floor, residential above a storefront. Occupants reported out of the building.',
      prePlan: {
        matchType: 'ADDRESS',
        matchedAddress: '18 Nichols Ave',
        unit: null,
        occupancySummary:
          'Two-story wood-frame mixed occupancy: hardware store at grade, two apartments above. Rear exterior stair to the second floor. Knox box left of the front door.',
        hazards: ['Rooftop solar array', 'Propane cylinders cage, rear loading dock'],
        utilityShutoffs: [
          { utility: 'Gas', location: 'Rear exterior wall, left of the loading dock' },
          { utility: 'Electric', location: 'Basement, meter room at the bottom of the rear stair' },
        ],
        nearestHydrants: [
          {
            hydrantId: 'H-014',
            distanceMeters: 60,
            size: '4"',
            flowRatingGpm: 1000,
            flowClass: 'A',
          },
          {
            hydrantId: 'H-022',
            distanceMeters: 140,
            size: '4"',
            flowRatingGpm: 750,
            flowClass: 'B',
            status: 'OUT_OF_SERVICE',
          },
          {
            hydrantId: 'H-031',
            distanceMeters: 210,
            size: '5"',
            flowRatingGpm: 1250,
            flowClass: 'A',
          },
        ],
      },
      updates: [
        {
          updateId: 'demo-update-1',
          receivedAt: NOW - 9 * MINUTE,
          summary: 'Units: Engine 301, Truck 304',
          changes: [{ field: 'unitsRequested', from: 'Engine 301', to: 'Engine 301, Truck 304' }],
        },
        {
          updateId: 'demo-update-2',
          receivedAt: NOW - 5 * MINUTE,
          summary: 'Occupants reported out of the building',
          changes: [{ field: 'narrative', from: '', to: 'Occupants reported out of the building' }],
        },
      ],
    },
    reactions: {
      // Tone 1: officers and the first crew.
      'm-1': { ackStatus: 'DIRECT_TO_SCENE', tone: 1, etaMinutes: 5 },
      'm-2': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 4, assignedApparatusId: 'a-1' },
      'm-3': { ackStatus: 'DIRECT_TO_SCENE', tone: 1, etaMinutes: 4 },
      'm-6': { ackStatus: 'DIRECT_TO_SCENE', tone: 1, etaMinutes: 7 },
      'm-9': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 3, assignedApparatusId: 'a-2' },
      'm-12': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 3, assignedApparatusId: 'a-2' },
      'm-13': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 5, assignedApparatusId: 'a-1' },
      'm-15': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 4, assignedApparatusId: 'a-2' },
      'm-16': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 6, assignedApparatusId: 'a-2' },
      'm-7': { ackStatus: 'NOT_RESPONDING', tone: 1 },
      'm-10': { ackStatus: 'NOT_RESPONDING', tone: 1 },
      // Tone 2 brought in the rest.
      'm-4': { ackStatus: 'RESPONDING', tone: 2, etaMinutes: 9 },
      'm-14': { ackStatus: 'RESPONDING', tone: 2, etaMinutes: 8, assignedApparatusId: 'a-4' },
      'm-17': { ackStatus: 'RESPONDING', tone: 2, etaMinutes: 7, assignedApparatusId: 'a-1' },
      'm-20': { ackStatus: 'RESPONDING', tone: 2, etaMinutes: 10, assignedApparatusId: 'a-4' },
      'm-21': { ackStatus: 'RESPONDING', tone: 2, etaMinutes: 8, assignedApparatusId: 'a-4' },
      'm-23': { ackStatus: 'RESPONDING', tone: 2, etaMinutes: 11 },
      'm-24': { ackStatus: 'RESPONDING', tone: 2, etaMinutes: 12, assignedApparatusId: 'a-4' },
      'm-25': { ackStatus: 'DIRECT_TO_SCENE', tone: 2, etaMinutes: 9 },
      'm-26': { ackStatus: 'DIRECT_TO_SCENE', tone: 2, etaMinutes: 10 },
      'm-18': { ackStatus: 'NOT_RESPONDING', tone: 2 },
      'm-22': { ackStatus: 'NOT_RESPONDING', tone: 2 },
      'm-31': { ackStatus: 'NOT_RESPONDING', tone: 2 },
      // m-8, m-11, m-19, m-27, m-28: no response to either tone (see DEVICE_STATES).
    },
    faults: {
      'm-19': { smsFailure: 'Carrier rejected: destination unreachable' },
      'm-27': { pushFailure: 'APNs: BadDeviceToken (app reinstalled, token not refreshed)' },
      'm-8': { pushUnconfirmed: true },
      'm-28': { pushUnconfirmed: true },
    },
    seats: {
      'Engine 301': { OFF: 'm-9', DRIVER: 'm-12', NOZZLE: 'm-15', BACKUP: 'm-16' },
      'Rescue 300': { OFF: 'm-2', DRIVER: 'm-13', FF1: 'm-17' },
      'Engine 305': { DRIVER: 'm-14', NOZZLE: 'm-21', BACKUP: 'm-20', HYDRANT: 'm-24' },
    },
    outOfService: FLEET_STATUS_TODAY,
  },

  // Earlier today, inside the 2-hour active window so the list shows two rows: a commercial
  // fire alarm the alarm company cancelled, so the officer halted the ladder after tone 1.
  'NICHOLS-DEMO-2': {
    dispatchedAt: NOW - 95 * MINUTE,
    tonesFired: 1,
    ladderStatus: 'HALTED_MANUAL',
    nextToneScheduled: false,
    dispatch: {
      incidentType: 'Fire alarm activation',
      address: '44 White Plains Rd',
      crossStreets: 'Huntington Tpke',
      mapLink: null,
      narrative:
        'Commercial fire alarm, smoke detector zone 2 (kitchen). Keyholder en route. Alarm company called back: burnt food, occupant on site, cancel.',
      prePlan: {
        matchType: 'ADDRESS',
        matchedAddress: '44 White Plains Rd',
        unit: null,
        occupancySummary:
          'Single-story strip plaza, four tenants, fully sprinklered. FDC on the Huntington Tpke side. Alarm panel inside the main entrance of the deli.',
        hazards: ['Ansul hood system, deli kitchen'],
        utilityShutoffs: [{ utility: 'Gas', location: 'Meter bank, rear of building' }],
        nearestHydrants: [
          {
            hydrantId: 'H-052',
            distanceMeters: 35,
            size: '5"',
            flowRatingGpm: 1500,
            flowClass: 'AA',
          },
        ],
      },
      updates: [
        {
          updateId: 'demo-2-update-1',
          receivedAt: NOW - 91 * MINUTE,
          summary: 'Alarm company reports accidental activation, cancel',
          changes: [
            {
              field: 'narrative',
              from: '',
              to: 'Alarm company called back: burnt food, occupant on site, cancel.',
            },
          ],
        },
      ],
    },
    reactions: {
      'm-3': { ackStatus: 'DIRECT_TO_SCENE', tone: 1, etaMinutes: 4 },
      'm-9': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 3, assignedApparatusId: 'a-2' },
      'm-12': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 4, assignedApparatusId: 'a-2' },
      'm-19': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 5, assignedApparatusId: 'a-2' },
      'm-24': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 6 },
      'm-1': { ackStatus: 'NOT_RESPONDING', tone: 1 },
      'm-7': { ackStatus: 'NOT_RESPONDING', tone: 1 },
      'm-13': { ackStatus: 'NOT_RESPONDING', tone: 1 },
      'm-21': { ackStatus: 'NOT_RESPONDING', tone: 1 },
    },
    faults: {
      'm-27': { pushFailure: 'APNs: BadDeviceToken (app reinstalled, token not refreshed)' },
    },
    seats: { 'Engine 301': { OFF: 'm-9', DRIVER: 'm-12', NOZZLE: 'm-19' } },
    outOfService: FLEET_STATUS_TODAY,
  },

  // Yesterday: two-car MVA on the state road, one tone, Rescue 300 and Engine 305 went.
  'NICHOLS-DEMO-3': {
    dispatchedAt: NOW - 26 * HOUR,
    tonesFired: 1,
    ladderStatus: 'HALTED_MANUAL',
    nextToneScheduled: false,
    dispatch: {
      incidentType: 'Motor vehicle accident',
      address: 'Route 25 northbound at Daniels Farm Rd',
      crossStreets: 'Daniels Farm Rd',
      mapLink: null,
      narrative:
        'Two-car MVA, one vehicle into the guardrail, airbag deployment, occupants out and ambulatory. PD on scene requesting fire for fluids and traffic.',
      prePlan: null,
      updates: [],
    },
    reactions: {
      'm-6': { ackStatus: 'DIRECT_TO_SCENE', tone: 1, etaMinutes: 6 },
      'm-13': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 4, assignedApparatusId: 'a-1' },
      'm-17': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 5, assignedApparatusId: 'a-1' },
      'm-14': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 5, assignedApparatusId: 'a-4' },
      'm-20': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 7, assignedApparatusId: 'a-4' },
      'm-25': { ackStatus: 'DIRECT_TO_SCENE', tone: 1, etaMinutes: 8 },
      'm-26': { ackStatus: 'DIRECT_TO_SCENE', tone: 1, etaMinutes: 9 },
      'm-2': { ackStatus: 'NOT_RESPONDING', tone: 1 },
      'm-15': { ackStatus: 'NOT_RESPONDING', tone: 1 },
      'm-22': { ackStatus: 'NOT_RESPONDING', tone: 1 },
    },
    faults: {},
    seats: {
      'Rescue 300': { DRIVER: 'm-13', FF1: 'm-17' },
      'Engine 305': { DRIVER: 'm-14', NOZZLE: 'm-20' },
    },
    outOfService: FLEET_STATUS_TODAY,
  },

  // Two days ago, a weekday afternoon: brush fire with thin turnout. All three tones fired.
  'NICHOLS-DEMO-4': {
    dispatchedAt: NOW - 47 * HOUR,
    tonesFired: 3,
    ladderStatus: 'COMPLETED',
    nextToneScheduled: false,
    dispatch: {
      incidentType: 'Brush fire',
      address: 'Old Mine Park, Park St',
      crossStreets: 'Park St & Whitney Ave',
      mapLink: null,
      narrative:
        'Brush fire behind the pavilion, approximately a quarter acre, light wind out of the west. Park staff on scene, no structures threatened.',
      prePlan: null,
      updates: [
        {
          updateId: 'demo-4-update-1',
          receivedAt: NOW - 47 * HOUR + 8 * MINUTE,
          summary: 'Units: Brush 307, Engine 305, Utility 302',
          changes: [
            {
              field: 'unitsRequested',
              from: 'Brush 307',
              to: 'Brush 307, Engine 305, Utility 302',
            },
          ],
        },
      ],
    },
    reactions: {
      'm-11': { ackStatus: 'DIRECT_TO_SCENE', tone: 1, etaMinutes: 8 },
      'm-23': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 6, assignedApparatusId: 'a-7' },
      'm-9': { ackStatus: 'RESPONDING', tone: 2, etaMinutes: 10, assignedApparatusId: 'a-4' },
      'm-21': { ackStatus: 'RESPONDING', tone: 2, etaMinutes: 9, assignedApparatusId: 'a-7' },
      'm-16': { ackStatus: 'RESPONDING', tone: 3, etaMinutes: 14, assignedApparatusId: 'a-4' },
      'm-26': { ackStatus: 'DIRECT_TO_SCENE', tone: 3, etaMinutes: 15 },
      'm-1': { ackStatus: 'NOT_RESPONDING', tone: 1 },
      'm-2': { ackStatus: 'NOT_RESPONDING', tone: 1 },
      'm-3': { ackStatus: 'NOT_RESPONDING', tone: 1 },
      'm-12': { ackStatus: 'NOT_RESPONDING', tone: 2 },
      'm-14': { ackStatus: 'NOT_RESPONDING', tone: 2 },
      'm-15': { ackStatus: 'NOT_RESPONDING', tone: 2 },
      'm-18': { ackStatus: 'NOT_RESPONDING', tone: 3 },
      'm-20': { ackStatus: 'NOT_RESPONDING', tone: 3 },
    },
    faults: { 'm-19': { smsFailure: 'Carrier rejected: destination unreachable' } },
    seats: {
      'Brush 307': { DRIVER: 'm-23', FF1: 'm-21' },
      'Engine 305': { OFF: 'm-9', NOZZLE: 'm-16' },
    },
    outOfService: FLEET_STATUS_TODAY,
  },

  // Three days ago, late evening: CO alarm, no symptoms; meter readings clear after tone 2.
  'NICHOLS-DEMO-5': {
    dispatchedAt: NOW - 64 * HOUR,
    tonesFired: 2,
    ladderStatus: 'HALTED_MANUAL',
    nextToneScheduled: false,
    dispatch: {
      incidentType: 'CO alarm, no symptoms',
      address: '9 Shelton Rd',
      crossStreets: 'Shelton Rd & Edison Rd',
      mapLink: null,
      narrative:
        'Residential CO detector sounding, three occupants evacuated to the front yard, no symptoms. Gas-fired boiler in the basement.',
      prePlan: null,
      updates: [],
    },
    reactions: {
      'm-8': { ackStatus: 'DIRECT_TO_SCENE', tone: 1, etaMinutes: 5 },
      'm-14': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 5, assignedApparatusId: 'a-4' },
      'm-24': { ackStatus: 'RESPONDING', tone: 2, etaMinutes: 9, assignedApparatusId: 'a-4' },
      'm-4': { ackStatus: 'RESPONDING', tone: 2, etaMinutes: 10, assignedApparatusId: 'a-4' },
      'm-1': { ackStatus: 'NOT_RESPONDING', tone: 1 },
      'm-9': { ackStatus: 'NOT_RESPONDING', tone: 1 },
      'm-13': { ackStatus: 'NOT_RESPONDING', tone: 2 },
      'm-17': { ackStatus: 'NOT_RESPONDING', tone: 2 },
    },
    faults: {},
    seats: { 'Engine 305': { DRIVER: 'm-14', NOZZLE: 'm-24', BACKUP: 'm-4' } },
    outOfService: { 'Truck 304': 'Aerial hydraulic leak' },
  },
};

function seedFromDefinition(dispatchId: string, seed: DispatchSeed): void {
  const toneLadder = {
    status: seed.ladderStatus,
    currentToneSequence: seed.tonesFired,
    nextToneAt:
      seed.ladderStatus === 'ACTIVE' && seed.nextToneScheduled && seed.tonesFired < FINAL_TONE
        ? Math.max(NOW + 2 * MINUTE, seed.dispatchedAt + seed.tonesFired * TONE_GAP_SECONDS)
        : null,
  };
  DISPATCHES.set(dispatchId, { dispatchId, ...seed.dispatch, toneLadder, mutualAid: null });
  ROSTERS.set(dispatchId, rosterFor(seed));
  RECEIPTS.set(dispatchId, receiptsFor(seed));
  RIDING_BOARDS.set(dispatchId, ridingBoardFor(dispatchId, seed));
  DISPATCHED_AT.set(dispatchId, seed.dispatchedAt);
  ESCALATIONS.set(
    dispatchId,
    Array.from({ length: seed.tonesFired - 1 }, (_, index) => ({
      toneSequence: index + 2,
      escalatedAt: seed.dispatchedAt + (index + 1) * TONE_GAP_SECONDS,
      reason: 'Fewer than the required acknowledgements 90 s after the previous tone',
    })),
  );
}

// ---------------------------------------------------------------------------------------------
// Fresh dispatches (manual entry, and any id a test or the officer types in)
// ---------------------------------------------------------------------------------------------

function seedDispatch(dispatchId: string, input?: Partial<DispatchAlert>): DispatchAlert {
  return {
    dispatchId,
    incidentType: input?.incidentType ?? 'Structure fire',
    address: input?.address ?? '18 Nichols Ave',
    crossStreets: input?.crossStreets ?? 'Main St & Nichols Ave',
    mapLink: input?.mapLink ?? null,
    narrative: input?.narrative ?? 'Smoke showing from the second floor.',
    toneLadder: {
      status: 'ACTIVE',
      currentToneSequence: 1,
      nextToneAt: Math.floor(Date.now() / 1000) + TONE_GAP_SECONDS,
    },
    mutualAid: null,
    prePlan: {
      summary: 'Two-story wood-frame occupancy, residential above commercial.',
      hazards: ['Rooftop solar array'],
      utilityShutoffs: [{ utility: 'Gas', location: 'Rear exterior wall' }],
      nearestHydrants: [
        { hydrantId: 'H-014', distanceMeters: 60, size: '4"', flowRatingGpm: 1000, flowClass: 'A' },
      ],
    },
  };
}

/** A call that just went out: tone 1 only, the quick responders in, most still unanswered. */
const FRESH_REACTIONS: Record<string, Reaction> = {
  'm-2': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 10 },
  'm-3': { ackStatus: 'DIRECT_TO_SCENE', tone: 1, etaMinutes: 4 },
  'm-9': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 3 },
  'm-12': { ackStatus: 'RESPONDING', tone: 1, etaMinutes: 3 },
  'm-7': { ackStatus: 'NOT_RESPONDING', tone: 1 },
};

function ensureSeeded(dispatchId: string): void {
  if (DISPATCHES.has(dispatchId)) return;
  const dispatchedAt = Math.floor(Date.now() / 1000) - 60;
  const fresh = {
    dispatchedAt,
    tonesFired: 1,
    reactions: FRESH_REACTIONS,
    faults: {},
    seats: {},
    outOfService: FLEET_STATUS_TODAY,
  };
  DISPATCHES.set(dispatchId, seedDispatch(dispatchId));
  ROSTERS.set(dispatchId, rosterFor(fresh));
  RECEIPTS.set(dispatchId, receiptsFor(fresh));
  RIDING_BOARDS.set(dispatchId, ridingBoardFor(dispatchId, fresh));
  ESCALATIONS.set(dispatchId, []);
}

for (const [dispatchId, seed] of Object.entries(SEEDS)) seedFromDefinition(dispatchId, seed);

// ---------------------------------------------------------------------------------------------
// Canary: one synthetic page every 10 minutes for the last 24 hours
// ---------------------------------------------------------------------------------------------

const CANARY_INTERVAL_SECONDS = 10 * MINUTE;
const CANARY_RUN_COUNT = (24 * HOUR) / CANARY_INTERVAL_SECONDS;
/** The one failure: an SMS provider stall about six hours ago that blew the 5 s budget. */
const CANARY_FAIL_INDEX = (6 * HOUR) / CANARY_INTERVAL_SECONDS;

const CANARY_RUNS: readonly CanaryRun[] = Array.from({ length: CANARY_RUN_COUNT }, (_, index) => {
  const ranAt = NOW - 90 - index * CANARY_INTERVAL_SECONDS;
  // Deterministic jitter around a ~1.9 s baseline, with a tail on either side of the failure.
  const jitter = ((index * 7919) % 900) - 450;
  const nearFailure = Math.abs(index - CANARY_FAIL_INDEX);
  if (index === CANARY_FAIL_INDEX) {
    return {
      ranAt,
      result: 'FAIL',
      latencyMs: 7420,
      channelResults: { push: 'PASS', sms: 'FAIL', voice: 'PASS' },
    };
  }
  const latencyMs =
    nearFailure === 1 ? 4100 + jitter / 3 : nearFailure === 2 ? 2900 + jitter / 3 : 1900 + jitter;
  return {
    ranAt,
    result: 'PASS',
    latencyMs: Math.round(latencyMs),
    channelResults: { push: 'PASS', sms: 'PASS', voice: 'PASS' },
  };
});

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function conflict(detail: string): Response {
  return new Response(
    JSON.stringify({
      type: 'https://boxalarm.dev/problems/conflict',
      title: 'Conflict',
      status: 409,
      detail,
      traceId: 'demo',
    }),
    { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

/** Mirrors alerting-service/ladderControls: same preconditions, same 409s, same bodies. */
function demoLadderControl(
  dispatchId: string,
  control: string,
  body: Record<string, unknown>,
): Response | null {
  ensureSeeded(dispatchId);
  const dispatch = DISPATCHES.get(dispatchId)!;
  const ladder = dispatch.toneLadder!;
  const now = Math.floor(Date.now() / 1000);

  if (control === 'tone-ladder/advance') {
    if (ladder.status === 'HALTED_MANUAL') {
      return conflict('The tone ladder is halted. No tone was sent.');
    }
    if (ladder.status === 'COMPLETED' || ladder.currentToneSequence >= FINAL_TONE) {
      return conflict('Every tone has already fired. No tone was sent.');
    }
    if (body.expectedCurrentToneSequence !== ladder.currentToneSequence) {
      return conflict(
        `The ladder is now at tone ${ladder.currentToneSequence}, not tone ${String(body.expectedCurrentToneSequence)}. No tone was sent; refresh before advancing again.`,
      );
    }
    const toneSequence = ladder.currentToneSequence + 1;
    dispatch.toneLadder = {
      status: toneSequence >= FINAL_TONE ? 'COMPLETED' : 'ACTIVE',
      currentToneSequence: toneSequence,
      nextToneAt: toneSequence >= FINAL_TONE ? null : now + TONE_GAP_SECONDS,
    };
    const roster = ROSTERS.get(dispatchId) ?? [];
    RECEIPTS.set(dispatchId, [
      ...(RECEIPTS.get(dispatchId) ?? []),
      ...roster.map((entry) => ({
        memberId: entry.memberId,
        channel: 'PUSH',
        toneSequence,
        status: 'SENT' as const,
        sentAt: now,
        deliveredAt: null,
        openedAt: null,
        failureReason: null,
      })),
    ]);
    ESCALATIONS.set(dispatchId, [
      ...(ESCALATIONS.get(dispatchId) ?? []),
      { toneSequence, escalatedAt: now, reason: 'Manual override by officer' },
    ]);
    return json({ dispatchId, toneSequence, outcome: 'FIRED_MANUAL_OVERRIDE' });
  }

  if (control === 'tone-ladder/halt') {
    if (ladder.status === 'HALTED_MANUAL') {
      return json({ dispatchId, toneLadder: ladder, changed: false });
    }
    if (ladder.status === 'COMPLETED' || ladder.currentToneSequence >= FINAL_TONE) {
      return conflict('Every tone has already fired, so there is nothing left to halt.');
    }
    dispatch.toneLadder = { ...ladder, status: 'HALTED_MANUAL', nextToneAt: null };
    return json({
      dispatchId,
      toneLadder: { status: 'HALTED_MANUAL', currentToneSequence: ladder.currentToneSequence },
      changed: true,
    });
  }

  if (control === 'mutual-aid/trigger') {
    if (dispatch.mutualAid) {
      return json({
        dispatchId,
        created: false,
        officersNotified: 0,
        adapterUsed: 'OFFICER_MANUAL_PROMPT',
        mutualAid: dispatch.mutualAid,
      });
    }
    dispatch.mutualAid = {
      triggeredAt: now,
      reason: 'MANUAL',
      triggeredBy: 'demo-officer',
      acknowledgedBy: null,
      acknowledgedAt: null,
      notes: null,
    };
    return json({
      dispatchId,
      created: true,
      officersNotified: 2,
      adapterUsed: 'OFFICER_MANUAL_PROMPT',
      mutualAid: dispatch.mutualAid,
    });
  }

  if (control === 'mutual-aid/acknowledge') {
    const mutualAid = dispatch.mutualAid;
    if (!mutualAid) {
      return conflict(
        'Mutual aid has not been requested for this dispatch, so there is nothing to acknowledge.',
      );
    }
    if (mutualAid.acknowledgedAt !== null) {
      return mutualAid.acknowledgedBy === 'demo-officer'
        ? json({ dispatchId, changed: false, mutualAid })
        : conflict(
            'Mutual aid was already acknowledged by another officer. Your notes were not saved.',
          );
    }
    const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;
    dispatch.mutualAid = {
      ...mutualAid,
      acknowledgedBy: 'demo-officer',
      acknowledgedAt: now,
      notes,
    };
    return json({ dispatchId, changed: true, mutualAid: dispatch.mutualAid });
  }

  return null;
}

/**
 * The member's view of one dispatch, as alerting-service queryMemberDispatchTimeline returns it:
 * every receipt, each escalation that re-paged them, and the response they logged, oldest first.
 */
function diagnosticsTimeline(dispatchId: string, memberId: string): DiagnosticsTimelineEntry[] {
  const receipts = (RECEIPTS.get(dispatchId) ?? []).filter((r) => r.memberId === memberId);
  const entries: { at: number; entry: DiagnosticsTimelineEntry }[] = receipts.map((r) => ({
    at: r.sentAt,
    entry: {
      entityType: 'DELIVERY_RECEIPT',
      channel: r.channel,
      toneSequence: r.toneSequence,
      status: r.status,
      sentAt: r.sentAt,
      deliveredAt: r.deliveredAt,
      openedAt: r.openedAt,
      failureReason: r.failureReason,
    },
  }));
  for (const escalation of ESCALATIONS.get(dispatchId) ?? []) {
    entries.push({
      at: escalation.escalatedAt,
      entry: {
        entityType: 'ESCALATION_EVENT',
        toneSequence: escalation.toneSequence,
        escalatedAt: escalation.escalatedAt,
        reason: escalation.reason,
      },
    });
  }
  const rosterEntry = (ROSTERS.get(dispatchId) ?? []).find((r) => r.memberId === memberId);
  if (
    rosterEntry &&
    rosterEntry.ackStatus !== 'UNANSWERED' &&
    rosterEntry.lastAnsweredTone !== null
  ) {
    const tone = rosterEntry.lastAnsweredTone;
    const opened = receipts.find((r) => r.toneSequence === tone && r.openedAt !== null);
    const answeredAt =
      opened?.openedAt ?? (receipts.find((r) => r.toneSequence === tone)?.sentAt ?? 0) + 25;
    entries.push({
      at: answeredAt,
      entry: {
        entityType: 'DISPATCH_RESPONSE_RECORD',
        toneSequence: tone,
        answeredAt,
        ackStatus: rosterEntry.ackStatus,
      },
    });
  }
  return entries.sort((a, b) => a.at - b.at).map((item) => item.entry);
}

/** Returns null when the path isn't an alerting/apparatus-riding-board route this file owns. */
export function demoAlertsRequest(
  path: string,
  method: string,
  body: Record<string, unknown>,
): Response | null {
  const parts = path.split('/');

  if (path === 'alerting/home-locality' && method === 'GET') {
    return json({
      towns: ['Trumbull', 'Nichols', 'Long Hill', 'Trumbull Center'],
      zips: ['06611'],
      state: 'CT',
    });
  }
  if (path === 'alerting/dispatches' && method === 'POST') {
    dispatchCounter += 1;
    const dispatchId = `MANUAL-${dispatchCounter}`;
    const input = body as unknown as ManualDispatchInput;
    ensureSeeded(dispatchId);
    DISPATCHES.set(dispatchId, seedDispatch(dispatchId, input));
    DISPATCHED_AT.set(dispatchId, Math.floor(Date.now() / 1000));
    return json({ dispatchId, sourceSystem: 'MANUAL' }, 201);
  }

  if (path === 'alerting/dispatches' && method === 'GET') {
    const asOf = Math.floor(Date.now() / 1000);
    const list: ActiveDispatchList = {
      dispatches: [...DISPATCHED_AT.entries()]
        .filter(([, at]) => at >= asOf - DEMO_ACTIVE_WINDOW_SECONDS)
        .sort(([, a], [, b]) => b - a)
        .flatMap(([dispatchId, dispatchedAt]) => {
          const dispatch = DISPATCHES.get(dispatchId);
          if (!dispatch) return [];
          const ladder = dispatch.toneLadder;
          return [
            {
              dispatchId,
              incidentType: dispatch.incidentType,
              address: dispatch.address,
              crossStreets: dispatch.crossStreets,
              dispatchedAt,
              toneLadder: {
                status: ladder?.status ?? 'ACTIVE',
                currentToneSequence: ladder?.currentToneSequence ?? 1,
              },
            },
          ];
        }),
      activeWindowSeconds: DEMO_ACTIVE_WINDOW_SECONDS,
      asOf,
      truncated: false,
    };
    return json(list);
  }

  if (
    parts[0] === 'alerting' &&
    parts[1] === 'dispatches' &&
    parts.length === 3 &&
    method === 'GET'
  ) {
    const dispatchId = decodeURIComponent(parts[2] ?? '');
    ensureSeeded(dispatchId);
    return json(DISPATCHES.get(dispatchId));
  }

  if (
    parts[0] === 'alerting' &&
    parts[1] === 'dispatches' &&
    parts[3] === 'roster' &&
    method === 'GET'
  ) {
    const dispatchId = decodeURIComponent(parts[2] ?? '');
    ensureSeeded(dispatchId);
    return json({ members: ROSTERS.get(dispatchId) ?? [] });
  }

  if (
    parts[0] === 'alerting' &&
    parts[1] === 'dispatches' &&
    parts[3] === 'receipts' &&
    method === 'GET'
  ) {
    const dispatchId = decodeURIComponent(parts[2] ?? '');
    ensureSeeded(dispatchId);
    return json({ receipts: RECEIPTS.get(dispatchId) ?? [] });
  }

  if (
    parts[0] === 'alerting' &&
    parts[1] === 'dispatches' &&
    parts[3] === 'diagnostics' &&
    parts.length === 5 &&
    method === 'GET'
  ) {
    const dispatchId = decodeURIComponent(parts[2] ?? '');
    const memberId = decodeURIComponent(parts[4] ?? '');
    ensureSeeded(dispatchId);
    const roster = ROSTERS.get(dispatchId) ?? [];
    const onEligibleRoster = roster.some((entry) => entry.memberId === memberId);
    const result: DiagnosticsResult = {
      dispatchId,
      memberId,
      diagnosis: onEligibleRoster ? 'ON_ROSTER' : 'NOT_ON_ELIGIBLE_ROSTER',
      timeline: onEligibleRoster ? diagnosticsTimeline(dispatchId, memberId) : [],
      deviceState: DEVICE_STATES.get(memberId) ?? null,
    };
    return json(result);
  }

  if (
    parts[0] === 'alerting' &&
    parts[1] === 'dispatches' &&
    parts.length === 5 &&
    (parts[3] === 'tone-ladder' || parts[3] === 'mutual-aid') &&
    method === 'POST'
  ) {
    const response = demoLadderControl(
      decodeURIComponent(parts[2] ?? ''),
      `${parts[3]}/${parts[4] ?? ''}`,
      body,
    );
    if (response) return response;
  }

  if (path === 'alerting/canary/status' && method === 'GET') {
    const latest = CANARY_RUNS[0];
    const status: CanaryStatus = {
      healthy: latest?.result === 'PASS',
      latestResult: latest?.result ?? null,
      latestLatencyMs: latest?.latencyMs ?? null,
      latestRanAt: latest?.ranAt ?? null,
      runs: [...CANARY_RUNS],
    };
    return json(status);
  }

  if (
    parts[0] === 'apparatus' &&
    parts[1] === 'riding-board' &&
    parts.length === 3 &&
    method === 'GET'
  ) {
    const dispatchId = decodeURIComponent(parts[2] ?? '');
    ensureSeeded(dispatchId);
    return json(RIDING_BOARDS.get(dispatchId));
  }

  if (
    parts[0] === 'apparatus' &&
    parts[1] === 'riding-board' &&
    parts[3] === 'assignments' &&
    method === 'POST'
  ) {
    const dispatchId = decodeURIComponent(parts[2] ?? '');
    ensureSeeded(dispatchId);
    const board = RIDING_BOARDS.get(dispatchId);
    const unit = board?.apparatus.find((a) => a.unitId === body.unitId);
    const position = unit?.positions.find((p) => p.code === body.positionCode);
    if (position) {
      const memberId = body.memberId;
      position.assignment =
        memberId === null || memberId === undefined
          ? undefined
          : {
              memberId: memberId as string,
              version: ((body.expectedVersion as number) ?? 0) + 1,
              assignedAt: Math.floor(Date.now() / 1000),
              assignedBy: 'demo',
              qualStatus: seatQualStatus(memberId as string, position),
            };
      // The roster's "Assigned" column follows the board, as the real projection does.
      const roster = ROSTERS.get(dispatchId) ?? [];
      for (const entry of roster) {
        if (entry.memberId === memberId && unit) entry.assignedApparatusId = unit.apparatusId;
      }
    }
    return json({ dispatchId, replayed: false });
  }

  return null;
}
