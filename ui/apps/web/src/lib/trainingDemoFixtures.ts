import type { ApiRequestOptions, ProblemDetails } from './apiClient';
import {
  DEMO_DRIVER_MEMBER_IDS,
  DEMO_INTERIOR_MEMBER_IDS,
  DEMO_MEMBER_BY_ID,
  DEMO_RESPONDING_MEMBER_IDS,
} from './demoRoster';
import type {
  Certification,
  ExpiringCertification,
  Transcript,
  TrainingEvent,
} from '../features/training/types';

/*
 * Demo-mode training records for the shared roster: certifications per member, eight months of
 * Monday-night drills with attendance, and the next five events. Dates are relative to module
 * load and every choice is derived from a string hash, so the same member always holds the same
 * cards and sat the same drills - a demo walkthrough is repeatable and never random.
 */

const NOW_MS = Date.now();
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** FNV-1a 32-bit: a stable, cheap spread for "did this member attend / when does this expire". */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function isoDaysFromNow(days: number): string {
  return new Date(NOW_MS + days * DAY_MS).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Certifications
// ---------------------------------------------------------------------------------------------

const CT_FIRE_ACADEMY = 'CT Commission on Fire Prevention and Control';
const CT_OEMS = 'CT DPH Office of Emergency Medical Services';
const AHA = 'American Heart Association';
const CT_DESPP = 'CT DESPP';

interface CertKind {
  certType: string;
  issuingAuthority: string;
  validYears: number;
}

const FF1: CertKind = {
  certType: 'Firefighter I',
  issuingAuthority: CT_FIRE_ACADEMY,
  validYears: 5,
};
const FF2: CertKind = {
  certType: 'Firefighter II',
  issuingAuthority: CT_FIRE_ACADEMY,
  validYears: 5,
};
const HAZMAT_OPS: CertKind = { certType: 'Hazmat Ops', issuingAuthority: CT_DESPP, validYears: 3 };
const HAZMAT_AWARENESS: CertKind = {
  certType: 'Hazmat Awareness',
  issuingAuthority: CT_DESPP,
  validYears: 3,
};
const DRIVER_PUMPER: CertKind = {
  certType: 'Driver/Operator - Pumper',
  issuingAuthority: CT_FIRE_ACADEMY,
  validYears: 5,
};
const DRIVER_AERIAL: CertKind = {
  certType: 'Driver/Operator - Aerial',
  issuingAuthority: CT_FIRE_ACADEMY,
  validYears: 5,
};
const FIRE_OFFICER_1: CertKind = {
  certType: 'Fire Officer I',
  issuingAuthority: CT_FIRE_ACADEMY,
  validYears: 5,
};
const FIRE_OFFICER_2: CertKind = {
  certType: 'Fire Officer II',
  issuingAuthority: CT_FIRE_ACADEMY,
  validYears: 5,
};
const INSTRUCTOR_1: CertKind = {
  certType: 'Fire Service Instructor I',
  issuingAuthority: CT_FIRE_ACADEMY,
  validYears: 5,
};
const FIRE_POLICE: CertKind = {
  certType: 'Fire Police',
  issuingAuthority: CT_FIRE_ACADEMY,
  validYears: 5,
};
const CPR: CertKind = { certType: 'CPR/AED and First Aid', issuingAuthority: AHA, validYears: 2 };
const EMR: CertKind = { certType: 'EMR', issuingAuthority: CT_OEMS, validYears: 3 };

const OFFICER_RANKS = new Set([
  'Chief',
  'Deputy Chief',
  'Assistant Chief',
  'Captain',
  'Lieutenant',
  'Safety Officer',
]);
const CHIEF_OFFICER_RANKS = new Set(['Chief', 'Deputy Chief', 'Assistant Chief', 'Captain']);
const AERIAL_DRIVER_IDS = new Set(['m-9', 'm-13']);
/** FF2 holders: every other interior member - the same split the alerting roster's quals use. */
const FF2_MEMBER_IDS = new Set(DEMO_INTERIOR_MEMBER_IDS.filter((_, index) => index % 2 === 0));
/** Members whose CPR card lapsed and was never renewed. */
const NO_CPR_IDS = new Set(['m-19', 'm-22', 'm-28']);

/**
 * Expiry overrides, in days from today: the three cards coming due inside 60 days (the
 * reporting fixtures point at m-3's EMR at 21 days) and the two already expired.
 */
const EXPIRY_OVERRIDES: Record<string, number> = {
  'm-3|EMR': 21,
  'm-14|CPR/AED and First Aid': 38,
  'm-21|Hazmat Ops': 55,
  'm-1|Hazmat Ops': -217,
  'm-18|CPR/AED and First Aid': -70,
};

function certKindsFor(memberId: string): CertKind[] {
  const member = DEMO_MEMBER_BY_ID.get(memberId);
  if (!member) return [];
  const kinds: CertKind[] = [];
  if (member.rank === 'Fire Police') {
    kinds.push(FIRE_POLICE, HAZMAT_AWARENESS);
  } else if (member.rank === 'Administrative Member') {
    // Office role: first aid only.
  } else if (member.status === 'PROBATIONARY') {
    // Firefighter I is still in progress at the academy.
    kinds.push(HAZMAT_AWARENESS);
  } else if (member.status === 'ACTIVE') {
    kinds.push(FF1);
    if (FF2_MEMBER_IDS.has(memberId)) kinds.push(FF2);
    kinds.push(HAZMAT_OPS);
  }
  if (DEMO_DRIVER_MEMBER_IDS.includes(memberId)) kinds.push(DRIVER_PUMPER);
  if (AERIAL_DRIVER_IDS.has(memberId)) kinds.push(DRIVER_AERIAL);
  if (OFFICER_RANKS.has(member.rank)) kinds.push(FIRE_OFFICER_1);
  if (CHIEF_OFFICER_RANKS.has(member.rank)) kinds.push(FIRE_OFFICER_2);
  if (memberId === 'm-7') kinds.push(INSTRUCTOR_1);
  if (memberId === 'm-3') kinds.push(EMR);
  if (!NO_CPR_IDS.has(memberId)) kinds.push(CPR);
  return kinds;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function buildCertification(memberId: string, kind: CertKind): Certification {
  const key = `${memberId}|${kind.certType}`;
  // Spread expiries from four months to a little under four years out, unless pinned above.
  const expiresInDays = EXPIRY_OVERRIDES[key] ?? 120 + (hash(key) % 1300);
  return {
    certId: `CERT-${memberId}-${slug(kind.certType)}`,
    memberId,
    certType: kind.certType,
    issueDate: isoDaysFromNow(expiresInDays - kind.validYears * 365),
    expiryDate: isoDaysFromNow(expiresInDays),
    issuingAuthority: kind.issuingAuthority,
    attachmentS3Key: null,
    status: expiresInDays < 0 ? 'EXPIRED' : 'CURRENT',
  };
}

let certifications: Certification[] = DEMO_RESPONDING_MEMBER_IDS.flatMap((memberId) =>
  certKindsFor(memberId).map((kind) => buildCertification(memberId, kind)),
);

/** training/certifications/expiring: current cards due inside the department's 90-day window. */
const EXPIRING_WINDOW_DAYS = 90;

// ---------------------------------------------------------------------------------------------
// Events: Monday-night drills every two weeks, one live burn, and the next five on the calendar
// ---------------------------------------------------------------------------------------------

/** Local midnight on the most recent Monday whose 19:00 drill has already happened. */
function lastDrillMonday(): Date {
  const today = new Date(NOW_MS);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const daysSinceMonday = (midnight.getDay() + 6) % 7;
  const monday = new Date(midnight.getTime() - daysSinceMonday * DAY_MS);
  // A Monday before this evening's drill still counts as "this week's drill not yet held".
  if (daysSinceMonday === 0 && NOW_MS < monday.getTime() + 21 * HOUR_MS) {
    return new Date(monday.getTime() - 7 * DAY_MS);
  }
  return monday;
}

interface DrillSeed {
  title: string;
  category: string;
  /** Saturday academy day instead of a Monday night. */
  saturday?: true;
  /** Interior-qualified members only (live fire). */
  interiorOnly?: true;
}

/** Oldest last: index 0 is the most recent drill. */
const PAST_DRILLS: readonly DrillSeed[] = [
  { title: 'Aerial operations - Truck 304 setup and short-jacking', category: 'Ladders' },
  { title: 'Apparatus familiarization - Squad 309', category: 'Apparatus' },
  { title: 'Rope and knots, hauling systems', category: 'Rope' },
  { title: 'Mayday procedures and radio discipline', category: 'RIT' },
  { title: 'Ventilation - roof cuts and PPV', category: 'Ventilation' },
  { title: 'Forcible entry - doors and padlocks', category: 'Forcible entry' },
  { title: 'Search and rescue - primary search', category: 'Search' },
  { title: 'Hydrant flow testing', category: 'Water supply' },
  { title: 'CO and four-gas meter operations', category: 'Hazmat' },
  { title: 'Vehicle extrication - stabilization and door removal', category: 'Extrication' },
  {
    title: 'Live burn - regional fire academy',
    category: 'Live fire',
    saturday: true,
    interiorOnly: true,
  },
  { title: 'RIT deployment', category: 'RIT' },
  { title: 'Pump operations - relay and drafting', category: 'Pump ops' },
  { title: 'SCBA confidence course', category: 'SCBA' },
  { title: 'Hose line advancement, 1¾" and 2½"', category: 'Hose' },
  { title: 'Ground ladders - raises and carries', category: 'Ladders' },
];

const UPCOMING_DRILLS: readonly { title: string; category: string; weeksOut: number }[] = [
  { title: 'Hose line drill', category: 'Hose', weeksOut: 0 },
  { title: 'SCBA drill - mask confidence', category: 'SCBA', weeksOut: 1 },
  { title: 'Pump operations', category: 'Pump ops', weeksOut: 2 },
  {
    title: 'Officer development - size-up and the 360',
    category: 'Officer development',
    weeksOut: 3,
  },
];

/** The signed-in demo user (lib/demoFixtures.ts' first member), whose sign-ups the page shows. */
const DEMO_USER_ID = 'm-1';

interface AttendanceRecord {
  memberId: string;
  hours: number;
}

const attendance = new Map<string, AttendanceRecord[]>();

function attendedDrill(eventId: string, memberId: string, seed: DrillSeed): boolean {
  if (seed.interiorOnly && !DEMO_INTERIOR_MEMBER_IDS.includes(memberId)) return false;
  // The training officer runs every drill; everyone else makes roughly three in five.
  if (memberId === 'm-7') return true;
  return hash(`${eventId}|${memberId}`) % 100 < 60;
}

function buildEvents(): TrainingEvent[] {
  const monday = lastDrillMonday().getTime();
  const drillStart = (mondayMs: number) => mondayMs + 19 * HOUR_MS;

  const past: TrainingEvent[] = PAST_DRILLS.map((seed, index) => {
    const eventId = `evt-${index + 2}`;
    const week = monday - index * 14 * DAY_MS;
    const startAt = seed.saturday ? week - 2 * DAY_MS + 8 * HOUR_MS : drillStart(week);
    const hours = seed.saturday ? 8 : 2;
    const attendees = DEMO_RESPONDING_MEMBER_IDS.filter((memberId) =>
      attendedDrill(eventId, memberId, seed),
    ).map((memberId) => ({ memberId, hours }));
    attendance.set(eventId, attendees);
    return {
      eventId,
      title: seed.title,
      category: seed.category,
      startAt,
      endAt: startAt + hours * HOUR_MS,
      signedUp: attendees.some((a) => a.memberId === DEMO_USER_ID),
    };
  });

  const nextMonday = monday + 7 * DAY_MS;
  const upcoming: TrainingEvent[] = UPCOMING_DRILLS.map((seed, index) => {
    const startAt = drillStart(nextMonday + seed.weeksOut * 7 * DAY_MS);
    return {
      eventId: `evt-${PAST_DRILLS.length + 2 + index}`,
      title: seed.title,
      category: seed.category,
      startAt,
      endAt: startAt + 2 * HOUR_MS,
      signedUp: seed.title === 'Pump operations',
    };
  });

  return [
    // evt-1 is tomorrow's drill the training e2e and unit tests know by name - keep it first.
    {
      eventId: 'evt-1',
      title: 'Ladder drill',
      category: 'Ladders',
      startAt: NOW_MS + 86_400_000,
      endAt: NOW_MS + 90_000_000,
      signedUp: false,
    },
    ...past,
    ...upcoming,
  ];
}

let events: TrainingEvent[] = buildEvents();

function transcriptFor(memberId: string): Transcript {
  const rows = events.flatMap((event) =>
    (attendance.get(event.eventId) ?? [])
      .filter((a) => a.memberId === memberId)
      .map((a) => ({
        eventId: event.eventId,
        category: event.category,
        hours: a.hours,
        startAt: event.startAt,
      })),
  );
  rows.sort((a, b) => b.startAt - a.startAt);
  const hoursByCategory: Record<string, number> = {};
  for (const row of rows) {
    hoursByCategory[row.category] = (hoursByCategory[row.category] ?? 0) + row.hours;
  }
  return {
    memberId,
    certifications: certifications.filter((c) => c.memberId === memberId),
    attendance: rows,
    hoursByCategory,
  };
}

// ---------------------------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function problem(status: number, title: string): Response {
  const body: ProblemDetails = { type: 'about:blank', title, status, traceId: 'demo' };
  return json(body, status);
}

export async function trainingDemoRequest(
  path: string,
  options: ApiRequestOptions = {},
): Promise<Response | undefined> {
  const method = (options.method ?? 'GET').toUpperCase();
  const body = options.body ? (JSON.parse(options.body as string) as Record<string, unknown>) : {};
  const parts = path.split('/');

  if (parts[0] !== 'training') return undefined;

  if (path === 'training/certifications/expiring' && method === 'GET') {
    const horizon = isoDaysFromNow(EXPIRING_WINDOW_DAYS);
    const due: ExpiringCertification[] = certifications
      .filter((c) => c.status === 'CURRENT' && c.expiryDate <= horizon)
      .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))
      .map((c) => ({
        certId: c.certId,
        memberId: c.memberId,
        certType: c.certType,
        expiryDate: c.expiryDate,
        issuingAuthority: c.issuingAuthority,
        status: c.status,
      }));
    return json(due);
  }

  if (parts[1] === 'members' && parts[3] === 'certifications' && parts.length === 4) {
    const memberId = decodeURIComponent(parts[2] ?? '');
    if (method === 'GET') {
      return json(certifications.filter((c) => c.memberId === memberId));
    }
    if (method === 'POST') {
      const created: Certification = {
        certId: `CERT-${certifications.length + 1}`,
        memberId,
        certType: body.certType as string,
        issueDate: body.issueDate as string,
        expiryDate: body.expiryDate as string,
        issuingAuthority: body.issuingAuthority as string,
        attachmentS3Key: null,
        status: 'CURRENT',
      };
      certifications = [...certifications, created];
      return json(created, 201);
    }
  }

  if (parts[1] === 'members' && parts[3] === 'certifications' && parts[5] === 'revoke') {
    const memberId = decodeURIComponent(parts[2] ?? '');
    const certId = decodeURIComponent(parts[4] ?? '');
    let updated: Certification | undefined;
    certifications = certifications.map((c) => {
      if (c.memberId !== memberId || c.certId !== certId) return c;
      updated = { ...c, status: 'REVOKED' };
      return updated;
    });
    return updated ? json(updated) : problem(404, 'Certification not found');
  }

  if (parts[1] === 'members' && parts[3] === 'transcript') {
    return json(transcriptFor(decodeURIComponent(parts[2] ?? '')));
  }

  // The demo router strips the query string before it reaches here, so the range cannot be
  // honoured: this is every recorded hour, reported as the calendar year to date.
  if (path === 'training/hours' && method === 'GET') {
    const byMember = new Map<string, Map<string, number>>();
    for (const event of events) {
      for (const record of attendance.get(event.eventId) ?? []) {
        const categories = byMember.get(record.memberId) ?? new Map<string, number>();
        categories.set(event.category, (categories.get(event.category) ?? 0) + record.hours);
        byMember.set(record.memberId, categories);
      }
    }
    const yearStart = new Date(new Date(NOW_MS).getFullYear(), 0, 1).getTime();
    return json({
      from: yearStart,
      to: NOW_MS,
      members: [...byMember.entries()].map(([memberId, categories]) => ({
        memberId,
        categories: [...categories.entries()]
          .map(([category, hours]) => ({ category, hours }))
          .sort((a, b) => a.category.localeCompare(b.category)),
      })),
    });
  }

  if (path === 'training/events' && method === 'GET') {
    return json(events);
  }

  if (path === 'training/events' && method === 'POST') {
    const created: TrainingEvent = {
      eventId: `evt-${events.length + 1}`,
      title: body.title as string,
      category: body.category as string,
      startAt: body.startAt as number,
      endAt: body.endAt as number,
      signedUp: false,
    };
    events = [...events, created];
    return json(created, 201);
  }

  // One route, two writes (training api.ts): a bare POST is the caller's own sign-up; a body
  // with `attendees` records hours for the members listed.
  if (parts[1] === 'events' && parts[3] === 'signup' && method === 'POST') {
    const eventId = decodeURIComponent(parts[2] ?? '');
    const event = events.find((e) => e.eventId === eventId);
    if (!event) return problem(404, 'Event not found');
    const attendees = body.attendees;
    if (Array.isArray(attendees)) {
      const existing = attendance.get(eventId) ?? [];
      for (const attendee of attendees as AttendanceRecord[]) {
        const current = existing.find((a) => a.memberId === attendee.memberId);
        if (current) current.hours = attendee.hours;
        else existing.push({ memberId: attendee.memberId, hours: attendee.hours });
      }
      attendance.set(eventId, existing);
      return json({ eventId, attendeeCount: existing.length });
    }
    events = events.map((e) => (e.eventId === eventId ? { ...e, signedUp: true } : e));
    return json({ eventId });
  }

  return problem(404, 'Not found');
}
