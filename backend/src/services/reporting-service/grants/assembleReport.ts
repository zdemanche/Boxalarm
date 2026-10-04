import type {
  ApparatusOosHistory,
  MemberCountAndTrend,
  ReportPeriod,
  TrainingHoursCompliance,
} from './repository.js';

export const DEFAULT_GRANT_REPORT_FIELDS = [
  'activeMemberCount',
  'memberCountTrend',
  'totalIncidentVolume',
  'trainingHoursCompliance',
  'apparatusOutOfServiceHistory',
] as const;

export type GrantReportField = (typeof DEFAULT_GRANT_REPORT_FIELDS)[number];

export interface IncidentVolumeAvailable {
  readonly available: true;
  readonly totalIncidents: number;
}

export interface IncidentVolumeUnavailable {
  readonly available: false;
  /**
   * `E6-S1` is the historical scope-gap reason (no incident-table read existed at all).
   * `#251` closed that gap; an unavailable result past that point is always `INFRA_ERROR`
   * (fail-soft on a Query/config failure) — the literal `E6-S1` value is kept only so a
   * caller that cached the old shape still type-checks against this union.
   */
  readonly reason: 'E6-S1' | 'INFRA_ERROR';
}

export type IncidentVolume = IncidentVolumeAvailable | IncidentVolumeUnavailable;

export interface AssembleGrantsReportInput {
  readonly period: ReportPeriod;
  readonly memberCountAndTrend: MemberCountAndTrend;
  readonly trainingHoursCompliance: TrainingHoursCompliance;
  readonly apparatusOosHistory: ApparatusOosHistory;
  readonly incidentVolume: IncidentVolume;
}

export interface GrantsReport {
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly fields: typeof DEFAULT_GRANT_REPORT_FIELDS;
  readonly fieldSetSource: 'default';
  readonly activeMemberCount: number;
  readonly memberCountTrend: {
    readonly joinedInPeriod: number;
    readonly trendMethod: 'joinDateApproximation';
  };
  readonly totalIncidentVolume: IncidentVolume;
  readonly trainingHoursCompliance: TrainingHoursCompliance;
  readonly apparatusOutOfServiceHistory: ApparatusOosHistory;
}

// TODO: E7-CONFIG-EXT department-level grant field configurability (a DEPARTMENT_CONFIG
// GRANT_REPORT_FIELDS GetItem) is a known extension point, not read here — AC2 requires only
// this documented default field set.
export function assembleGrantsReport(input: AssembleGrantsReportInput): GrantsReport {
  return {
    periodStart: input.period.periodStart,
    periodEnd: input.period.periodEnd,
    fields: DEFAULT_GRANT_REPORT_FIELDS,
    fieldSetSource: 'default',
    activeMemberCount: input.memberCountAndTrend.activeMemberCount,
    memberCountTrend: {
      joinedInPeriod: input.memberCountAndTrend.joinedInPeriod,
      trendMethod: 'joinDateApproximation',
    },
    totalIncidentVolume: input.incidentVolume,
    trainingHoursCompliance: input.trainingHoursCompliance,
    apparatusOutOfServiceHistory: input.apparatusOosHistory,
  };
}
