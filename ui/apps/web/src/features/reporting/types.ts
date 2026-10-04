/**
 * Response shapes of the reporting-service handlers (backend/src/services/reporting-service).
 * Kept structurally identical to the backend's own interfaces; field comments note units.
 */

// GET reporting/dashboard (dashboard/assemble.ts DashboardView)
export interface DashboardView {
  /** ISO timestamp of the last rollup write, or null when no event has been projected yet. */
  lastUpdated: string | null;
  staffing: {
    activeMemberCount: number;
    unavailableCount: number;
    shiftCoverage: { gapCount: number; gaps: { shiftId: string; gapReason: string }[] };
  };
  outOfServiceApparatus: { unitId: string; reason: string; durationSeconds: number | null }[];
  expiringCertifications: {
    count: number;
    certifications: { memberId: string; certId: string; expiryDate: string }[];
  };
  nerisCompliance: {
    pendingCount: number;
    failedCount: number;
    submissions: { incidentId: string; status: 'PENDING' | 'FAILED'; href: string }[];
  };
}

// responseTimes/compute.ts
export interface TimeSummary {
  medianSeconds: number | null;
  p90Seconds: number | null;
  sampleCount: number;
  excludedCount: number;
}

export interface UnitResponseTimes {
  incidentId: string;
  unitId: string;
  turnoutSeconds: number | null;
  travelSeconds: number | null;
  totalSeconds: number | null;
}

export interface ResponseTimeAnalytics {
  units: UnitResponseTimes[];
  turnout: TimeSummary;
  travel: TimeSummary;
  total: TimeSummary;
}

/** GET reporting/response-times — `from`/`to` are epoch seconds of the incident alarm time. */
export interface ResponseTimesReport extends ResponseTimeAnalytics {
  from: number;
  to: number;
}

// GET reporting/iso (iso/repository.ts IsoReport)
export interface IsoReport {
  from: number;
  to: number;
  trainingHours: { totalHours: number; categories: { category: string; totalHours: number }[] };
  apparatusTests: { byType: { testType: string; passCount: number; failCount: number }[] };
  hydrantFlowTests: {
    count: number;
    currentCount: number;
    overdueCount: number;
    hydrants: { hydrantId: string; nextFlowTestDue: string; current: boolean }[];
  };
  responseTimes: ResponseTimeAnalytics;
}

export const ACTIVITY_TYPES = ['CALL', 'DRILL', 'MEETING', 'WORK_DETAIL', 'STANDBY'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

// GET reporting/membership-trends (lib/membershipTrend.ts MembershipTrendResult)
export interface MembershipTrends {
  periodStart: string;
  periodEnd: string;
  startCount: number;
  endCount: number;
  joins: number;
  departures: number;
  netChange: number;
  buckets: {
    /** YYYY-MM */
    bucket: string;
    activeMemberCount: number;
    /** Fraction 0..1 of that month's active members who attended at least one of the type. */
    attendanceRateByActivityType: Record<ActivityType, number>;
  }[];
}

// GET reporting/grants (grants/assembleReport.ts GrantsReport) — period bounds are epoch ms.
export interface GrantsReport {
  periodStart: number;
  periodEnd: number;
  fields: readonly string[];
  fieldSetSource: 'default';
  activeMemberCount: number;
  memberCountTrend: { joinedInPeriod: number; trendMethod: 'joinDateApproximation' };
  totalIncidentVolume: { available: false; reason: string };
  trainingHoursCompliance: { totalHours: number; memberCount: number; eventCount: number };
  apparatusOutOfServiceHistory: {
    records: { unitId: string; reason: string; startAt: number; endAt: number | null }[];
    totalOutOfServiceEvents: number;
  };
}

// GET reporting/losap/year-end (losap/repository.ts LosapYearEndReport)
export interface LosapYearEndReport {
  deptId: string;
  year: number;
  members: {
    memberId: string;
    totalPoints: number;
    entryCount: number;
    unreadableEntryCount: number;
  }[];
  hasData: boolean;
  totalUnreadableEntryCount: number;
}

// POST reporting/export, GET reporting/export/{jobId} (export/render.ts)
export const REPORT_NAMES = [
  'dashboard',
  'losap',
  'iso',
  'grants',
  'response-times',
  'membership-trends',
] as const;
export type ReportName = (typeof REPORT_NAMES)[number];
export type ExportFormat = 'csv' | 'pdf';

export type ReportExportStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

export interface ReportExportAccepted {
  jobId: string;
  status: ReportExportStatus;
}

export interface ReportExportJob {
  jobId: string;
  report: ReportName;
  format: ExportFormat;
  status: ReportExportStatus;
  requestedAt: string;
  /** Present only once the job is COMPLETED — a 15-minute signed S3 link. */
  downloadUrl?: string;
}

// GET/POST reporting/cutover-decision (reporting-service cutoverDecision)
export type CutoverDecisionStatus = 'accept' | 'defer';

export interface MemberDeliveryView {
  memberId: string;
  sent: number;
  delivered: number;
  missedPageCount: number;
  deliveryRate: number;
}

export interface DeliveryBaselineView {
  periodFrom: number;
  periodTo: number;
  deliveryRate: number;
  missedPageCount: number;
  timeToFirstAckAverageSeconds: number | null;
  timeToFirstAckMedianSeconds: number | null;
  perMember: MemberDeliveryView[];
  meetsThreshold: boolean;
  threshold: number;
}

/** GET reporting/cutover-decision. `deliveryBaseline` is present only when the request carried
 * `?from&to` (cutoverDecision/get.ts `wantsBaseline`). */
export interface CutoverDecisionView {
  decision: CutoverDecisionStatus | null;
  decider: string | null;
  decidedAt: number | null;
  /** False only once an `accept` decision is on record — never flips on `defer` alone. */
  retainedPagingRequired: boolean;
  deliveryBaseline?: DeliveryBaselineView;
}

/** POST reporting/cutover-decision response (cutoverDecision/post.ts `record`). */
export interface CutoverDecisionRecord {
  decision: CutoverDecisionStatus;
  decider: string;
  decidedAt: number;
}

// GET reporting/neris-compliance (reporting-service nerisCompliance)
export interface NerisOpenDraft {
  id: string;
  ageHours: number;
  /** Cognito sub of the report's owner; never shown on screen. */
  owner: string;
  /** Display name of the owner; null when the member record can't be found. */
  ownerName: string | null;
  status: string;
  locked: boolean;
}

export interface NerisCompliance {
  windowDays: number;
  /** 0-100, one decimal; null when no report fell due in the window. */
  submittedWithin72hPct: number | null;
  /** 0-100, one decimal; null when nothing was submitted in the window. */
  rejectionRate: number | null;
  submittedCount: number;
  rejectedCount: number;
  /** Reports NERIS refused at send time (validation); included in rejectedCount and the rate. */
  validationRejectedCount: number;
  eligibleCount: number;
  /** Oldest first, at most 20. */
  openDrafts: NerisOpenDraft[];
}
