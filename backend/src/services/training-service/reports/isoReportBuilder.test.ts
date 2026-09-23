import { describe, expect, it } from 'vitest';
import type { AttendanceRecord } from '../repository.js';
import { buildIsoReport, mapToIsoCategory } from './isoReportBuilder.js';

describe('mapToIsoCategory', () => {
  it('normalizes case and surrounding whitespace to a single taxonomy key', () => {
    expect(mapToIsoCategory('ladder_ops')).toBe('LADDER_OPS');
    expect(mapToIsoCategory('  EMS  ')).toBe('EMS');
  });

  it('buckets empty/whitespace-only category into UNCATEGORIZED rather than dropping it', () => {
    expect(mapToIsoCategory('')).toBe('UNCATEGORIZED');
    expect(mapToIsoCategory('   ')).toBe('UNCATEGORIZED');
  });
});

describe('buildIsoReport', () => {
  const RECORDS: readonly AttendanceRecord[] = [
    { eventId: 'e1', memberId: 'MBR-1', category: 'ems', hours: 3 },
    { eventId: 'e1', memberId: 'MBR-2', category: 'ems', hours: 3 },
    { eventId: 'e2', memberId: 'MBR-1', category: 'LADDER_OPS', hours: 2 },
    { eventId: 'e3', memberId: 'MBR-1', category: 'ems', hours: 1 },
  ];

  it('groups hours by ISO category with per-member and department totals that reconcile exactly against the source rows (AC1, AC2)', () => {
    const report = buildIsoReport(RECORDS, 2026);

    const sourceTotal = RECORDS.reduce((sum, record) => sum + record.hours, 0);
    expect(report.period).toBe(2026);
    expect(report.departmentTotalHours).toBe(sourceTotal);

    const ems = report.categories.find((category) => category.category === 'EMS');
    expect(ems?.totalHours).toBe(7);
    expect(ems?.members).toEqual([
      { memberId: 'MBR-1', hours: 4 },
      { memberId: 'MBR-2', hours: 3 },
    ]);

    const ladderOps = report.categories.find((category) => category.category === 'LADDER_OPS');
    expect(ladderOps?.totalHours).toBe(2);
    expect(ladderOps?.members).toEqual([{ memberId: 'MBR-1', hours: 2 }]);
  });

  it('returns a valid zero-totals report rather than an error when no records exist for the period (AC3)', () => {
    const report = buildIsoReport([], 2026);

    expect(report).toEqual({ period: 2026, departmentTotalHours: 0, categories: [] });
  });
});
