import { describe, expect, it } from 'vitest';
import { DEFAULT_GRANT_REPORT_FIELDS, assembleGrantsReport } from './assembleReport.js';
import type { AssembleGrantsReportInput } from './assembleReport.js';

const BASE_INPUT: AssembleGrantsReportInput = {
  period: { periodStart: 1_700_000_000_000, periodEnd: 1_702_000_000_000 },
  memberCountAndTrend: { activeMemberCount: 42, joinedInPeriod: 3 },
  trainingHoursCompliance: { totalHours: 120, memberCount: 18, eventCount: 6 },
  apparatusOosHistory: {
    records: [{ unitId: 'ENGINE-2', reason: 'brakes', startAt: 1_700_100_000, endAt: null }],
    totalOutOfServiceEvents: 1,
  },
  incidentVolume: { available: false, reason: 'E6-S1' },
};

describe('DEFAULT_GRANT_REPORT_FIELDS', () => {
  it('documents the AFG/SAFER-aligned default field set (AC2)', () => {
    expect(DEFAULT_GRANT_REPORT_FIELDS).toEqual([
      'activeMemberCount',
      'memberCountTrend',
      'totalIncidentVolume',
      'trainingHoursCompliance',
      'apparatusOutOfServiceHistory',
    ]);
  });
});

describe('assembleGrantsReport', () => {
  it('assembles the four source domains plus the requested period into one report body (AC1)', () => {
    const report = assembleGrantsReport(BASE_INPUT);

    expect(report).toEqual({
      periodStart: BASE_INPUT.period.periodStart,
      periodEnd: BASE_INPUT.period.periodEnd,
      fields: DEFAULT_GRANT_REPORT_FIELDS,
      fieldSetSource: 'default',
      activeMemberCount: 42,
      memberCountTrend: { joinedInPeriod: 3, trendMethod: 'joinDateApproximation' },
      totalIncidentVolume: { available: false, reason: 'E6-S1' },
      trainingHoursCompliance: BASE_INPUT.trainingHoursCompliance,
      apparatusOutOfServiceHistory: BASE_INPUT.apparatusOosHistory,
    });
  });

  it('labels the member trend as a joinDate approximation, not an audited status-history delta (AC1 assumption)', () => {
    const report = assembleGrantsReport(BASE_INPUT);
    expect(report.memberCountTrend.trendMethod).toBe('joinDateApproximation');
  });

  it('carries the default field set through even when the department has never configured one (AC2)', () => {
    const report = assembleGrantsReport(BASE_INPUT);
    expect(report.fieldSetSource).toBe('default');
    expect(report.fields).toBe(DEFAULT_GRANT_REPORT_FIELDS);
  });

  it('reports incident volume as unavailable rather than inventing incident data (AC1 scope gap)', () => {
    const report = assembleGrantsReport(BASE_INPUT);
    expect(report.totalIncidentVolume).toEqual({ available: false, reason: 'E6-S1' });
  });
});
