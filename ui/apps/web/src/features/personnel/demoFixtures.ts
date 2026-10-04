import {
  DEMO_DRIVER_MEMBER_IDS,
  DEMO_INTERIOR_MEMBER_IDS,
  DEMO_MEMBER_BY_ID,
  DEMO_MEMBERS,
  DEMO_RESPONDING_MEMBER_IDS,
} from '../../lib/demoRoster';
import type { AttendanceActivityType, AttendanceRecord, LosapTotal, Qualification } from './types';

const DAY_SECONDS = 24 * 60 * 60;
const NOW_SECONDS = Math.floor(Date.now() / 1000);
const CURRENT_YEAR = new Date().getFullYear();

/** Deterministic 0..1 for a seed - the demo must look the same on every load. */
function hash01(seed: number): number {
  return (((seed + 1) * 2654435761) >>> 0) / 4294967296;
}

function qual(qualCode: string, grantedByCertId: string | null = null): Qualification {
  return { qualCode, grantedByCertId, currentlyEligible: true };
}

const FIRE_POLICE_IDS = DEMO_MEMBERS.filter((m) => m.rank === 'Fire Police').map((m) => m.memberId);

/**
 * Qualifications for every responding member: OFFICER for officers and the chief, INTERIOR for
 * the interior-qualified, DRIVER_OPERATOR for the engineers and officers who drive, EXTERIOR and
 * FIRE_POLICE for fire police. Probationary members earn theirs as they go - m-4 has EXTERIOR;
 * the two newest have none yet. Cert ids follow the training fixtures' naming.
 */
function buildQuals(): Record<string, Qualification[]> {
  const quals: Record<string, Qualification[]> = {};
  DEMO_RESPONDING_MEMBER_IDS.forEach((memberId, index) => {
    const member = DEMO_MEMBER_BY_ID.get(memberId);
    if (!member || member.rank === 'Administrative Member') return;
    const list: Qualification[] = [];
    const certSuffix = String(100 + index * 7).padStart(4, '0');
    if (member.roles?.includes('OFFICER') || member.roles?.includes('CHIEF')) {
      list.push(qual('OFFICER'));
    }
    if (memberId === 'm-3') {
      // Kept from the original fixture: the member page links this qual to its cert.
      list.push(qual('INTERIOR', 'CERT-0091'));
    } else if (DEMO_INTERIOR_MEMBER_IDS.includes(memberId)) {
      list.push(qual('INTERIOR', `FF1-${certSuffix}`));
    }
    if (DEMO_DRIVER_MEMBER_IDS.includes(memberId)) {
      list.push(qual('DRIVER_OPERATOR', `PUMP-${certSuffix}`));
    }
    if (FIRE_POLICE_IDS.includes(memberId)) {
      list.push(qual('EXTERIOR'), qual('FIRE_POLICE', `FP-${certSuffix}`));
    }
    if (memberId === 'm-11') {
      // Safety officer: not on the interior list, so exterior plus the safety-officer qual.
      list.push(qual('EXTERIOR'), qual('SAFETY_OFFICER', `ISO-${certSuffix}`));
    }
    if (memberId === 'm-4') list.push(qual('EXTERIOR'));
    if (list.length > 0) quals[memberId] = list;
  });
  return quals;
}

const quals: Record<string, Qualification[]> = buildQuals();

// Points so far this year. The chief, deputy, captain and probationary figures match the
// reporting fixtures' LOSAP year-end; the rest follow rank and tenure.
const LOSAP_POINTS: Record<string, number> = {
  'm-1': 64,
  'm-2': 58,
  'm-3': 41,
  'm-4': 12,
  'm-5': 6,
  'm-6': 55,
  'm-7': 52,
  'm-8': 47,
  'm-9': 61,
  'm-10': 44,
  'm-11': 38,
  'm-12': 57,
  'm-13': 66,
  'm-14': 49,
  'm-15': 35,
  'm-16': 31,
  'm-17': 29,
  'm-18': 40,
  'm-19': 27,
  'm-20': 33,
  'm-21': 46,
  'm-22': 24,
  'm-23': 51,
  'm-24': 22,
  'm-25': 43,
  'm-26': 39,
  'm-27': 9,
  'm-28': 4,
  'm-29': 3,
  'm-30': 0,
  'm-31': 18,
};

const losap: Record<string, LosapTotal> = Object.fromEntries(
  DEMO_MEMBERS.map((member) => [
    member.memberId,
    {
      memberId: member.memberId,
      year: CURRENT_YEAR,
      totalPoints: LOSAP_POINTS[member.memberId] ?? 0,
    },
  ]),
);

interface AttendanceShape {
  activityType: AttendanceActivityType;
  count: number;
  /** Hours: a base plus up to `spread` more, in half-hour steps. */
  baseHours: number;
  spread: number;
  /** Local hour the activity usually starts. */
  startHour: number;
  withRef: boolean;
}

// The signed-in demo member's last twelve months: a chief who makes most calls, the Tuesday
// drills, the monthly meeting, and a few work details. One LOSAP point per activity, matching
// the LOSAP_POINT_RULES config.
const ATTENDANCE_SHAPE: readonly AttendanceShape[] = [
  { activityType: 'CALL', count: 45, baseHours: 0.5, spread: 2.5, startHour: 0, withRef: true },
  { activityType: 'DRILL', count: 22, baseHours: 2, spread: 1, startHour: 19, withRef: false },
  {
    activityType: 'MEETING',
    count: 10,
    baseHours: 1.5,
    spread: 0.5,
    startHour: 19,
    withRef: false,
  },
  {
    activityType: 'WORK_DETAIL',
    count: 4,
    baseHours: 3,
    spread: 1,
    startHour: 9,
    withRef: false,
  },
];

function buildAttendance(): AttendanceRecord[] {
  const records: AttendanceRecord[] = [];
  let callNumber = 0;
  ATTENDANCE_SHAPE.forEach((shape, shapeIndex) => {
    for (let i = 0; i < shape.count; i += 1) {
      const seed = shapeIndex * 1000 + i;
      // Spread evenly across the year with a jitter of up to three days, oldest first.
      const daysAgo = Math.min(
        364,
        Math.floor(((shape.count - i - 0.5) / shape.count) * 362 + hash01(seed) * 3),
      );
      const hour =
        shape.activityType === 'CALL' ? Math.floor(hash01(seed + 17) * 24) : shape.startHour;
      const occurredAt =
        NOW_SECONDS - daysAgo * DAY_SECONDS - ((NOW_SECONDS % DAY_SECONDS) - hour * 3600);
      const hours = shape.baseHours + Math.round(hash01(seed + 29) * shape.spread * 2) / 2;
      if (shape.withRef) callNumber += 1 + Math.floor(hash01(seed + 41) * 6);
      records.push({
        activityType: shape.activityType,
        refId: shape.withRef
          ? `NFD-${String(CURRENT_YEAR).slice(2)}-${String(callNumber).padStart(4, '0')}`
          : null,
        occurredAt,
        hours,
        losapPointsAwarded: 1,
      });
    }
  });
  return records.sort((a, b) => a.occurredAt - b.occurredAt);
}

let attendance: AttendanceRecord[] = buildAttendance();

// One upcoming mark-off, so the list and Cancel are visible in demo mode without implying the
// demo member is unavailable right now.
const demoMarkOffStart = NOW_SECONDS + 86_400;
let markOffs: { markoffId: string; startAt: number; endAt: number; reason?: string }[] = [
  {
    markoffId: String(demoMarkOffStart),
    startAt: demoMarkOffStart,
    endAt: demoMarkOffStart + 43_200,
    reason: 'Travel',
  },
];

export function tryHandlePersonnelExtras(
  parts: string[],
  method: string,
  body: Record<string, unknown>,
): Response | undefined {
  if (parts[0] !== 'personnel') return undefined;

  if (parts[1] === 'attendance') {
    if (method === 'GET') return json({ records: attendance });
    if (method === 'POST') {
      const record: AttendanceRecord = {
        activityType: body.activityType as AttendanceRecord['activityType'],
        refId: (body.refId as string | null) ?? null,
        occurredAt: body.occurredAt as number,
        hours: body.hours as number,
      };
      attendance = [...attendance, record];
      return json(record, 201);
    }
  }

  if (parts[1] === 'members' && parts[3] === 'availability' && parts.length === 4) {
    // Mirrors availability/handler.ts and markoffs.ts: markoffId is the startAt as a string.
    if (method === 'GET') return json({ markOffs });
    if (method === 'POST') {
      const startAt = body.startAt as number;
      markOffs = [
        ...markOffs,
        {
          markoffId: String(startAt),
          startAt,
          endAt: body.endAt as number,
          ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        },
      ].sort((a, b) => a.startAt - b.startAt);
      return json(
        {
          memberId: decodeURIComponent(parts[2] ?? ''),
          startAt: body.startAt,
          endAt: body.endAt,
          affectsAlerting: true,
          ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        },
        201,
      );
    }
  }

  if (
    parts[1] === 'members' &&
    parts[3] === 'availability' &&
    parts[5] === 'end' &&
    method === 'POST'
  ) {
    const markoffId = decodeURIComponent(parts[4] ?? '');
    const markOff = markOffs.find((m) => m.markoffId === markoffId);
    if (!markOff) return json({ type: 'about:blank', title: 'Not Found', status: 404 }, 404);
    const nowSeconds = Math.floor(Date.now() / 1000);
    markOffs = markOffs.filter((m) => m.markoffId !== markoffId);
    return json({ markoffId, endedAt: nowSeconds, cancelled: markOff.startAt > nowSeconds });
  }

  if (parts[1] === 'members' && parts[3] === 'quals') {
    const memberId = decodeURIComponent(parts[2] ?? '');
    if (method === 'GET') return json(quals[memberId] ?? []);
    if (method === 'PUT') {
      const qual: Qualification = {
        qualCode: body.qualCode as string,
        grantedByCertId: (body.grantedByCertId as string | null) ?? null,
        currentlyEligible: body.grantedByCertId === null || body.grantedByCertId === undefined,
      };
      quals[memberId] = [...(quals[memberId] ?? []), qual];
      return json(qual);
    }
  }

  if (parts[1] === 'members' && parts[3] === 'losap' && method === 'GET') {
    const memberId = decodeURIComponent(parts[2] ?? '');
    const total = losap[memberId] ?? { memberId, year: CURRENT_YEAR, totalPoints: 0 };
    return json(total);
  }

  return undefined;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
