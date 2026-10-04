import type { ProblemDetails } from '../../lib/apiClient';
import { DEMO_MEMBERS, DEMO_MEMBER_BY_ID, demoMemberName } from '../../lib/demoRoster';
import { demoIncidentState } from '../incidents/demoFixtures';
import type { Incident, ResponseUnit } from '../incidents/types';
import {
  ACTIVITY_TYPES,
  REPORT_NAMES,
  type ActivityType,
  type CutoverDecisionRecord,
  type CutoverDecisionStatus,
  type CutoverDecisionView,
  type DashboardView,
  type DeliveryBaselineView,
  type ExportFormat,
  type GrantsReport,
  type IsoReport,
  type LosapYearEndReport,
  type MembershipTrends,
  type NerisCompliance,
  type ReportExportJob,
  type ReportName,
  type ResponseTimeAnalytics,
  type TimeSummary,
  type UnitResponseTimes,
} from './types';

/**
 * VITE_DEMO fixtures for /reporting, shaped exactly like the reporting-service responses and
 * computed from the other demo stores: the incident history (incidents/demoFixtures.ts) drives
 * response times, NERIS compliance and incident volume; the shared roster (lib/demoRoster.ts)
 * drives staffing, membership trends and LOSAP. Validation mirrors the handlers', so a bad range
 * fails in demo the way it fails for real. No Math.random: the same inputs give the same report.
 */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function problem(status: number, title: string, detail?: string): Response {
  const body: ProblemDetails = { type: 'about:blank', title, status, traceId: 'demo', detail };
  return json(body, status);
}

const DAY_S = 86_400;
const DAY_MS = 86_400_000;

/** Stable 0..1 value for a string key, for per-member / per-month jitter. */
function unitHash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  return (h % 10_000) / 10_000;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function isoDateInDays(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Roster facts shared by several reports

const ACTIVE_MEMBER_IDS = DEMO_MEMBERS.filter((m) => m.status === 'ACTIVE').map((m) => m.memberId);
const RESPONDER_IDS = DEMO_MEMBERS.filter(
  (m) =>
    (m.status === 'ACTIVE' || m.status === 'PROBATIONARY') && m.rank !== 'Administrative Member',
).map((m) => m.memberId);

/** Status changes the roster implies but does not date: when leave and retirement began. */
const SEPARATION_DATE: Record<string, string> = { 'm-30': '2026-03-15' };
const LEAVE_START: Record<string, string> = { 'm-5': '2026-05-01', 'm-29': '2026-08-01' };

function dateSeconds(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 1000);
}

/** Members who were active (not yet on leave, not retired, already joined) on a given day. */
function activeOn(isoDate: string): number {
  return DEMO_MEMBERS.filter((m) => {
    if (m.joinDate > isoDate) return false;
    const separated = SEPARATION_DATE[m.memberId];
    if (separated !== undefined && separated <= isoDate) return false;
    if (m.status === 'RETIRED' && separated === undefined) return false;
    const leave = LEAVE_START[m.memberId];
    if (leave !== undefined && leave <= isoDate) return false;
    if (m.status === 'LOA' && leave === undefined) return false;
    return true;
  }).length;
}

// ---------------------------------------------------------------------------------------------
// Training and apparatus facts (owned by the training/apparatus fixtures; summarized here)

const TRAINING_HOURS_PER_MONTH: { category: string; hours: number; everyNthMonth?: number }[] = [
  { category: 'PUMP_OPS', hours: 4 },
  { category: 'SEARCH_RESCUE', hours: 3 },
  { category: 'SCBA', hours: 2 },
  { category: 'DRIVER_TRAINING', hours: 2 },
  { category: 'HAZMAT', hours: 2, everyNthMonth: 2 },
  { category: 'VEHICLE_EXTRICATION', hours: 3, everyNthMonth: 3 },
  { category: 'LIVE_FIRE', hours: 6, everyNthMonth: 6 },
];

/** Training by category across the months a range touches (month keys YYYY-MM). */
function trainingHours(months: string[]): {
  totalHours: number;
  categories: { category: string; totalHours: number }[];
} {
  const totals = new Map<string, number>();
  for (const month of months) {
    const monthIndex = Number(month.slice(5, 7));
    for (const item of TRAINING_HOURS_PER_MONTH) {
      if (item.everyNthMonth && monthIndex % item.everyNthMonth !== 0) continue;
      totals.set(item.category, (totals.get(item.category) ?? 0) + item.hours);
    }
  }
  const categories = [...totals.entries()]
    .map(([category, hours]) => ({ category, totalHours: hours }))
    .sort((a, b) => b.totalHours - a.totalHours);
  return { totalHours: categories.reduce((sum, c) => sum + c.totalHours, 0), categories };
}

interface ApparatusTestEvent {
  unitId: string;
  testType: string;
  daysAgo: number;
  passed: boolean;
}

const APPARATUS_TESTS: ApparatusTestEvent[] = [
  { unitId: 'Engine 301', testType: 'PUMP', daysAgo: 150, passed: true },
  { unitId: 'Engine 305', testType: 'PUMP', daysAgo: 150, passed: true },
  { unitId: 'Rescue 300', testType: 'PUMP', daysAgo: 149, passed: true },
  { unitId: 'Truck 304', testType: 'LADDER', daysAgo: 148, passed: true },
  { unitId: 'Truck 304', testType: 'LADDER', daysAgo: 2, passed: false },
  { unitId: 'Engine 301', testType: 'HOSE', daysAgo: 120, passed: true },
  { unitId: 'Engine 305', testType: 'HOSE', daysAgo: 120, passed: true },
];

interface OutOfServiceEvent {
  unitId: string;
  reason: string;
  startDaysAgo: number;
  endDaysAgo: number | null;
}

const OUT_OF_SERVICE: OutOfServiceEvent[] = [
  { unitId: 'Truck 304', reason: 'Aerial hydraulic leak', startDaysAgo: 2, endDaysAgo: null },
  { unitId: 'Engine 305', reason: 'Brake job', startDaysAgo: 95, endDaysAgo: 92 },
  { unitId: 'Rescue 300', reason: 'Generator replacement', startDaysAgo: 201, endDaysAgo: 199 },
];

// ---------------------------------------------------------------------------------------------
// Incident-derived figures

function incidentsBetween(fromSeconds: number, toSeconds: number): Incident[] {
  return demoIncidentState()
    .incidents.filter((incident) => {
      const at = incident.alarmAt ?? incident.epochSeconds;
      return at >= fromSeconds && at <= toSeconds;
    })
    .sort((a, b) => (a.alarmAt ?? 0) - (b.alarmAt ?? 0));
}

function summarize(values: number[]): TimeSummary {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { medianSeconds: null, p90Seconds: null, sampleCount: 0, excludedCount: 0 };
  }
  const at = (fraction: number): number => {
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const lowerValue = sorted[lower] ?? 0;
    const upperValue = sorted[upper] ?? lowerValue;
    return round1(lowerValue + (upperValue - lowerValue) * (position - lower));
  };
  return {
    medianSeconds: at(0.5),
    p90Seconds: at(0.9),
    sampleCount: sorted.length,
    excludedCount: 0,
  };
}

function unitTimes(unit: ResponseUnit): UnitResponseTimes {
  const turnout =
    unit.enRouteAt !== undefined && unit.dispatchedAt !== undefined
      ? unit.enRouteAt - unit.dispatchedAt
      : null;
  const travel =
    unit.arrivedAt !== undefined && unit.enRouteAt !== undefined
      ? unit.arrivedAt - unit.enRouteAt
      : null;
  const total =
    unit.arrivedAt !== undefined && unit.dispatchedAt !== undefined
      ? unit.arrivedAt - unit.dispatchedAt
      : null;
  return {
    incidentId: unit.incidentId,
    unitId: unit.unitId,
    turnoutSeconds: turnout !== null && turnout >= 0 ? turnout : null,
    travelSeconds: travel !== null && travel >= 0 ? travel : null,
    totalSeconds: total !== null && total >= 0 ? total : null,
  };
}

/** Same arithmetic as reporting-service responseTimes/compute.ts over the demo units. */
function responseTimes(fromSeconds: number, toSeconds: number): ResponseTimeAnalytics {
  const { unitsByIncident } = demoIncidentState();
  const units = incidentsBetween(fromSeconds, toSeconds).flatMap((incident) =>
    (unitsByIncident.get(incident.incidentId) ?? [])
      .filter((unit) => unit.unitType === 'APPARATUS')
      .map(unitTimes),
  );
  const leg = (pick: (unit: UnitResponseTimes) => number | null): TimeSummary => {
    const measured = units.map(pick).filter((value): value is number => value !== null);
    return { ...summarize(measured), excludedCount: units.length - measured.length };
  };
  return {
    units,
    turnout: leg((unit) => unit.turnoutSeconds),
    travel: leg((unit) => unit.travelSeconds),
    total: leg((unit) => unit.totalSeconds),
  };
}

/** The two Trumbull incident types a grant reviewer cares about most are already labelled. */
function incidentVolume(fromSeconds: number, toSeconds: number) {
  const counts = new Map<string, number>();
  const inRange = incidentsBetween(fromSeconds, toSeconds);
  for (const incident of inRange) {
    const type = incident.incidentType ?? 'Unclassified';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return {
    available: true as const,
    total: inRange.length,
    byType: [...counts.entries()]
      .map(([incidentType, count]) => ({ incidentType, count }))
      .sort((a, b) => b.count - a.count || a.incidentType.localeCompare(b.incidentType)),
  };
}

// ---------------------------------------------------------------------------------------------
// Reports

function dashboard(): DashboardView {
  const { incidents } = demoIncidentState();
  const pending = incidents.filter((incident) => incident.status === 'SUBMITTED');
  const failed = incidents.filter((incident) => incident.status === 'REJECTED');
  const certification = (memberId: string, certId: string, inDays: number) => ({
    memberId,
    memberName: demoMemberName(memberId),
    certId,
    expiryDate: isoDateInDays(inDays),
  });
  const certifications = [
    certification('m-3', 'EMR', 21),
    certification('m-12', 'Pump Operator refresher', 38),
    certification('m-19', 'CPR/AED', 54),
  ];
  return {
    lastUpdated: new Date(Date.now() - 12 * 60_000).toISOString(),
    staffing: {
      activeMemberCount: ACTIVE_MEMBER_IDS.length,
      unavailableCount: 2,
      shiftCoverage: {
        gapCount: 1,
        gaps: [{ shiftId: 'Sat 18:00–06:00 duty crew', gapReason: 'No driver/operator signed up' }],
      },
    },
    outOfServiceApparatus: OUT_OF_SERVICE.filter((event) => event.endDaysAgo === null).map(
      (event) => ({
        unitId: event.unitId,
        reason: event.reason,
        durationSeconds: event.startDaysAgo * DAY_S,
      }),
    ),
    expiringCertifications: { count: certifications.length, certifications },
    nerisCompliance: {
      pendingCount: pending.length,
      failedCount: failed.length,
      submissions: [
        ...failed.map((incident) => ({
          incidentId: incident.incidentId,
          status: 'FAILED' as const,
          href: `/api/v1/incidents/${incident.incidentId}`,
        })),
        ...pending.map((incident) => ({
          incidentId: incident.incidentId,
          status: 'PENDING' as const,
          href: `/api/v1/incidents/${incident.incidentId}`,
        })),
      ],
    },
  };
}

function nerisCompliance(windowDays: number): NerisCompliance {
  const now = Math.floor(Date.now() / 1000);
  const { ledgerByIncident } = demoIncidentState();
  const inWindow = incidentsBetween(now - windowDays * DAY_S, now);
  const dueBy = now - 72 * 3600;
  const eligible = inWindow.filter((incident) => (incident.alarmAt ?? 0) <= dueBy);
  const onTime = eligible.filter((incident) => {
    const sentAt = ledgerByIncident.get(incident.incidentId)?.firstSubmittedAt;
    return sentAt !== undefined && sentAt !== null && sentAt - (incident.alarmAt ?? 0) <= 72 * 3600;
  });
  const submitted = inWindow.filter(
    (incident) => ledgerByIncident.get(incident.incidentId)?.firstSubmittedAt != null,
  );
  const rejected = inWindow.filter((incident) => incident.status === 'REJECTED');
  const openDrafts = inWindow
    .filter((incident) => incident.status === 'DRAFT' || incident.status === 'VALIDATED')
    .sort((a, b) => (a.alarmAt ?? 0) - (b.alarmAt ?? 0))
    .slice(0, 20)
    .map((incident) => ({
      id: incident.incidentId,
      ageHours: Math.round((now - (incident.alarmAt ?? now)) / 3600),
      owner: incident.createdBy,
      ownerName: DEMO_MEMBER_BY_ID.has(incident.createdBy)
        ? demoMemberName(incident.createdBy)
        : null,
      status: incident.status,
      locked: Boolean(incident.lockedAt),
    }));
  return {
    windowDays,
    submittedWithin72hPct:
      eligible.length === 0 ? null : round1((onTime.length / eligible.length) * 100),
    rejectionRate:
      submitted.length === 0 ? null : round1((rejected.length / submitted.length) * 100),
    submittedCount: submitted.length,
    rejectedCount: rejected.length,
    validationRejectedCount: rejected.length,
    eligibleCount: eligible.length,
    openDrafts,
  };
}

function monthKeys(startDate: string, endDate: string): string[] {
  const keys: string[] = [];
  const cursor = new Date(`${startDate.slice(0, 7)}-01T00:00:00Z`);
  const end = endDate.slice(0, 7);
  while (cursor.toISOString().slice(0, 7) <= end && keys.length < 25) {
    keys.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

function monthKeysForSeconds(fromSeconds: number, toSeconds: number): string[] {
  return monthKeys(
    new Date(fromSeconds * 1000).toISOString().slice(0, 10),
    new Date(toSeconds * 1000).toISOString().slice(0, 10),
  );
}

function isoReport(from: number, to: number): IsoReport {
  const now = Math.floor(Date.now() / 1000);
  const byType = new Map<string, { passCount: number; failCount: number }>();
  for (const test of APPARATUS_TESTS) {
    const at = now - test.daysAgo * DAY_S;
    if (at < from || at > to) continue;
    const entry = byType.get(test.testType) ?? { passCount: 0, failCount: 0 };
    if (test.passed) entry.passCount += 1;
    else entry.failCount += 1;
    byType.set(test.testType, entry);
  }
  const today = new Date().toISOString().slice(0, 10);
  const hydrants = [
    { hydrantId: 'HYD-014', nextFlowTestDue: '2027-04-01' },
    { hydrantId: 'HYD-022', nextFlowTestDue: '2026-11-01' },
  ].map((hydrant) => ({ ...hydrant, current: hydrant.nextFlowTestDue >= today }));
  return {
    from,
    to,
    trainingHours: trainingHours(monthKeysForSeconds(from, to)),
    apparatusTests: {
      byType: [...byType.entries()]
        .map(([testType, counts]) => ({ testType, ...counts }))
        .sort((a, b) => a.testType.localeCompare(b.testType)),
    },
    hydrantFlowTests: {
      count: hydrants.length,
      currentCount: hydrants.filter((h) => h.current).length,
      overdueCount: hydrants.filter((h) => !h.current).length,
      hydrants,
    },
    responseTimes: responseTimes(from, to),
  };
}

/** Attendance rates: realistic bands per activity, jittered per month so the table has texture. */
const ATTENDANCE_BAND: Record<ActivityType, [low: number, high: number]> = {
  CALL: [0.52, 0.74],
  DRILL: [0.44, 0.66],
  MEETING: [0.5, 0.72],
  WORK_DETAIL: [0.12, 0.3],
  STANDBY: [0.08, 0.24],
};

function lastDayOfMonth(month: string): string {
  const cursor = new Date(`${month}-01T00:00:00Z`);
  cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  cursor.setUTCDate(0);
  return cursor.toISOString().slice(0, 10);
}

function membershipTrends(startDate: string, endDate: string): MembershipTrends {
  const joins = DEMO_MEMBERS.filter((m) => m.joinDate >= startDate && m.joinDate <= endDate).length;
  const departures = Object.values(SEPARATION_DATE).filter(
    (date) => date >= startDate && date <= endDate,
  ).length;
  const startCount = activeOn(startDate);
  const endCount = activeOn(endDate);
  return {
    periodStart: `${startDate}T00:00:00.000Z`,
    periodEnd: `${endDate}T23:59:59.999Z`,
    startCount,
    endCount,
    joins,
    departures,
    netChange: endCount - startCount,
    buckets: monthKeys(startDate, endDate).map((bucket) => {
      const monthEnd = lastDayOfMonth(bucket);
      const rates = {} as Record<ActivityType, number>;
      for (const type of ACTIVITY_TYPES) {
        const [low, high] = ATTENDANCE_BAND[type];
        rates[type] = Math.round((low + (high - low) * unitHash(`${bucket}:${type}`)) * 100) / 100;
      }
      return {
        bucket,
        activeMemberCount: activeOn(monthEnd < endDate ? monthEnd : endDate),
        attendanceRateByActivityType: rates,
      };
    }),
  };
}

function grantsReport(periodStart: number, periodEnd: number): GrantsReport {
  const now = Date.now();
  const startDate = new Date(periodStart).toISOString().slice(0, 10);
  const endDate = new Date(periodEnd).toISOString().slice(0, 10);
  const months = monthKeys(startDate, endDate);
  const records = OUT_OF_SERVICE.map((event) => ({
    unitId: event.unitId,
    reason: event.reason,
    startAt: now - event.startDaysAgo * DAY_MS,
    endAt: event.endDaysAgo === null ? null : now - event.endDaysAgo * DAY_MS,
  })).filter((record) => record.startAt <= periodEnd && (record.endAt ?? now) >= periodStart);
  return {
    periodStart,
    periodEnd,
    fields: [
      'activeMemberCount',
      'memberCountTrend',
      'totalIncidentVolume',
      'trainingHoursCompliance',
      'apparatusOutOfServiceHistory',
    ],
    fieldSetSource: 'default',
    activeMemberCount: ACTIVE_MEMBER_IDS.length,
    memberCountTrend: {
      joinedInPeriod: DEMO_MEMBERS.filter((m) => m.joinDate >= startDate && m.joinDate <= endDate)
        .length,
      trendMethod: 'joinDateApproximation',
    },
    totalIncidentVolume: incidentVolume(
      Math.floor(periodStart / 1000),
      Math.floor(periodEnd / 1000),
    ),
    trainingHoursCompliance: {
      totalHours: trainingHours(months).totalHours,
      memberCount: RESPONDER_IDS.length,
      eventCount: months.length * 3,
    },
    apparatusOutOfServiceHistory: { records, totalOutOfServiceEvents: records.length },
  };
}

/**
 * LOSAP year-end: calls come from the incident history (every responding member on a call earns
 * a point); drills, meetings and standbys are seeded per member. Points: 1 per call or meeting,
 * 2 per drill or standby, 10 for holding an officer position.
 */
function losapYearEnd(year: number): LosapYearEndReport {
  const thisYear = new Date().getFullYear();
  if (year !== thisYear && year !== thisYear - 1) {
    return {
      deptId: 'nichols-fd',
      year,
      members: [],
      hasData: false,
      totalUnreadableEntryCount: 0,
    };
  }
  const { incidents, membersByIncident } = demoIncidentState();
  const callsByMember = new Map<string, number>();
  for (const incident of incidents) {
    if (new Date((incident.alarmAt ?? 0) * 1000).getFullYear() !== year) continue;
    for (const member of membersByIncident.get(incident.incidentId) ?? []) {
      callsByMember.set(member.memberId, (callsByMember.get(member.memberId) ?? 0) + 1);
    }
  }
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const members = DEMO_MEMBERS.filter((m) => m.joinDate <= yearEnd)
    .filter((m) => {
      const separated = SEPARATION_DATE[m.memberId];
      return !(m.status === 'RETIRED' && (separated === undefined || separated < yearStart));
    })
    .map((m) => {
      const jitter = unitHash(`${year}:${m.memberId}`);
      // Members who joined, left or went on leave during the year have a partial year.
      const joined = m.joinDate > yearStart ? m.joinDate : yearStart;
      const left = SEPARATION_DATE[m.memberId] ?? LEAVE_START[m.memberId] ?? yearEnd;
      const span = Math.max(0, (dateSeconds(left) - dateSeconds(joined)) / (365 * DAY_S));
      const isOfficer = (m.roles ?? []).some((role) => role === 'OFFICER' || role === 'CHIEF');
      // Members now on leave or retired were already tapering off the year before.
      const taper = m.status === 'LOA' || m.status === 'RETIRED' ? 0.45 : 1;
      const seededCalls = year === thisYear ? 0 : Math.round((14 + jitter * 40) * span * taper);
      const calls = (callsByMember.get(m.memberId) ?? 0) + seededCalls;
      const drills = Math.round((8 + jitter * 12) * span * taper);
      const meetings = Math.round((5 + jitter * 6) * span * taper);
      const standbys = Math.round(jitter * 4 * span * taper);
      const entryCount = calls + drills + meetings + standbys + (isOfficer ? 1 : 0);
      return {
        memberId: m.memberId,
        memberName: demoMemberName(m.memberId),
        totalPoints: calls + drills * 2 + meetings + standbys * 2 + (isOfficer ? 10 : 0),
        entryCount,
        unreadableEntryCount: 0,
      };
    })
    .filter((row) => row.entryCount > 0)
    .sort((a, b) => b.totalPoints - a.totalPoints || a.memberId.localeCompare(b.memberId));
  return {
    deptId: 'nichols-fd',
    year,
    members,
    hasData: members.length > 0,
    totalUnreadableEntryCount: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// N1.9 cutover decision (#161): in-memory record plus a delivery baseline from the paging history

let cutoverDecision: CutoverDecisionRecord | null = null;

const CUTOVER_THRESHOLD = 0.95;

function deliveryBaseline(from: number, to: number): DeliveryBaselineView {
  const pages = incidentsBetween(from, to).length;
  const perMember = RESPONDER_IDS.map((memberId) => {
    const jitter = unitHash(`cutover:${memberId}`);
    // Roughly a fifth of the roster missed a page or two in the window (phone off, dead zone).
    const missedPageCount =
      pages === 0 ? 0 : jitter > 0.8 ? Math.min(pages, jitter > 0.93 ? 2 : 1) : 0;
    const delivered = pages - missedPageCount;
    return {
      memberId,
      memberName: demoMemberName(memberId),
      sent: pages,
      delivered,
      missedPageCount,
      deliveryRate: pages === 0 ? 1 : Math.round((delivered / pages) * 1000) / 1000,
    };
  });
  const sent = perMember.reduce((sum, m) => sum + m.sent, 0);
  const delivered = perMember.reduce((sum, m) => sum + m.delivered, 0);
  const deliveryRate = sent === 0 ? 1 : Math.round((delivered / sent) * 1000) / 1000;
  return {
    periodFrom: from,
    periodTo: to,
    deliveryRate,
    missedPageCount: sent - delivered,
    timeToFirstAckAverageSeconds: pages === 0 ? null : 47,
    timeToFirstAckMedianSeconds: pages === 0 ? null : 34,
    perMember,
    meetsThreshold: deliveryRate >= CUTOVER_THRESHOLD,
    threshold: CUTOVER_THRESHOLD,
  };
}

function cutoverView(query: URLSearchParams): CutoverDecisionView {
  const range = epochRange(query);
  return {
    decision: cutoverDecision?.decision ?? null,
    decider: cutoverDecision?.decider ?? null,
    decidedAt: cutoverDecision?.decidedAt ?? null,
    // Only an accept on record ends the retained-paging requirement; defer never does.
    retainedPagingRequired: cutoverDecision?.decision !== 'accept',
    ...(range ? { deliveryBaseline: deliveryBaseline(range.from, range.to) } : {}),
  };
}

function epochRange(query: URLSearchParams): { from: number; to: number } | undefined {
  const from = Number(query.get('from'));
  const to = Number(query.get('to'));
  if (
    !query.get('from') ||
    !query.get('to') ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from > to
  ) {
    return undefined;
  }
  return { from, to };
}

const exportJobs = new Map<string, ReportExportJob>();
let exportCounter = 0;

/**
 * `body` is the parsed JSON body of a POST (reporting/cutover-decision reads `decision` from
 * it); callers that only route GETs may leave it out.
 */
export function reportingDemoRequest(
  path: string,
  method: string,
  query: URLSearchParams,
  body: Record<string, unknown> = {},
): Response | undefined {
  const parts = path.split('/');
  if (parts[0] !== 'reporting') return undefined;

  if (path === 'reporting/dashboard' && method === 'GET') return json(dashboard());

  if (path === 'reporting/neris-compliance' && method === 'GET') {
    return json(nerisCompliance(Number(query.get('days') ?? 90) || 90));
  }

  if (path === 'reporting/response-times' && method === 'GET') {
    const range = epochRange(query);
    if (!range)
      return problem(400, 'Bad Request', 'from and to are required epoch seconds with from <= to');
    return json({ ...range, ...responseTimes(range.from, range.to) });
  }

  if (path === 'reporting/iso' && method === 'GET') {
    const range = epochRange(query);
    if (!range)
      return problem(400, 'Bad Request', 'from and to are required epoch seconds with from <= to');
    return json(isoReport(range.from, range.to));
  }

  if (path === 'reporting/membership-trends' && method === 'GET') {
    const startDate = query.get('startDate') ?? '';
    const endDate = query.get('endDate') ?? '';
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(endDate) ||
      startDate > endDate
    ) {
      return problem(
        400,
        'Bad Request',
        'startDate and endDate are required with startDate <= endDate',
      );
    }
    return json(membershipTrends(startDate, endDate));
  }

  if (path === 'reporting/grants' && method === 'GET') {
    const periodStart = Number(query.get('periodStart'));
    const periodEnd = Number(query.get('periodEnd'));
    if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd) || periodEnd <= periodStart) {
      return problem(400, 'Bad Request', 'periodEnd must be after periodStart');
    }
    return json(grantsReport(periodStart, periodEnd));
  }

  if (path === 'reporting/losap/year-end' && method === 'GET') {
    const year = query.get('year') ?? '';
    if (!/^\d{4}$/.test(year)) return problem(400, 'Bad Request', 'year must be a 4-digit year');
    return json(losapYearEnd(Number(year)));
  }

  if (path === 'reporting/cutover-decision' && method === 'GET') {
    if ((query.get('from') || query.get('to')) && !epochRange(query)) {
      return problem(400, 'Bad Request', 'from and to must both be epoch seconds with from <= to');
    }
    return json(cutoverView(query));
  }

  if (path === 'reporting/cutover-decision' && method === 'POST') {
    const decision = body.decision;
    if (decision !== 'accept' && decision !== 'defer') {
      return problem(400, 'Bad Request', 'decision must be one of: accept, defer');
    }
    cutoverDecision = {
      decision: decision as CutoverDecisionStatus,
      decider: demoMemberName('m-1'),
      decidedAt: Date.now(),
    };
    return json(cutoverDecision);
  }

  if (path === 'reporting/export' && method === 'POST') {
    const report = query.get('report') ?? '';
    const format = query.get('format') ?? '';
    if (
      !(REPORT_NAMES as readonly string[]).includes(report) ||
      (format !== 'csv' && format !== 'pdf')
    ) {
      return problem(400, 'Bad Request', 'report and format are required');
    }
    exportCounter += 1;
    const jobId = `demo-report-export-${exportCounter}`;
    exportJobs.set(jobId, {
      jobId,
      report: report as ReportName,
      format: format as ExportFormat,
      status: 'COMPLETED',
      requestedAt: new Date().toISOString(),
      // Demo mode has no S3; a same-page anchor stands in for the signed link.
      downloadUrl: `#${jobId}`,
    });
    return json({ jobId, status: 'PENDING' }, 202);
  }

  if (parts[1] === 'export' && parts.length === 3 && method === 'GET') {
    const job = exportJobs.get(decodeURIComponent(parts[2] ?? ''));
    return job ? json(job) : problem(404, 'Not Found', 'export job was not found');
  }

  return undefined;
}
