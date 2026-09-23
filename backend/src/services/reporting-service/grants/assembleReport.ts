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

export interface IncidentVolumeUnavailable {
  readonly available: false;
  readonly reason: 'E6-S1';
}

export interface AssembleGrantsReportInput {
  readonly period: ReportPeriod;
  readonly memberCountAndTrend: MemberCountAndTrend;
  readonly trainingHoursCompliance: TrainingHoursCompliance;
  readonly apparatusOosHistory: ApparatusOosHistory;
  readonly incidentVolume: IncidentVolumeUnavailable;
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
  readonly totalIncidentVolume: IncidentVolumeUnavailable;
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
