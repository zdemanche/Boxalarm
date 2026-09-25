import { describe, expect, it } from 'vitest';
import {
  monthBuckets,
  summarizeApparatusTests,
  summarizeHydrants,
  summarizeTrainingHours,
} from './summarize.js';

describe('ISO summarizers', () => {
  it('returns zeroed sections for empty inputs', () => {
    expect(summarizeTrainingHours([])).toEqual({ totalHours: 0, categories: [] });
    expect(summarizeApparatusTests([])).toEqual({ byType: [] });
    expect(summarizeHydrants([], '2026-02-28').count).toBe(0);
  });

  it('totals training hours by category and apparatus pass/fail by type', () => {
    expect(
      summarizeTrainingHours([
        { category: 'fire', hours: 2 },
        { category: 'Fire', hours: 1 },
        { category: '  ', hours: 4 },
      ]),
    ).toEqual({
      totalHours: 7,
      categories: [
        { category: 'FIRE', totalHours: 3 },
        { category: 'UNCATEGORIZED', totalHours: 4 },
      ],
    });
    expect(
      summarizeApparatusTests([
        { testType: 'PUMP', result: 'PASS' },
        { testType: 'PUMP', result: 'FAIL' },
        { testType: 'LADDER', result: 'PASS' },
      ]).byType,
    ).toEqual([
      { testType: 'LADDER', passCount: 1, failCount: 0 },
      { testType: 'PUMP', passCount: 1, failCount: 1 },
    ]);
  });

  it('lists every month bucket crossed by the range, including the boundary month', () => {
    const from = Date.parse('2026-01-20T00:00:00.000Z') / 1000;
    const to = Date.parse('2026-03-02T00:00:00.000Z') / 1000;
    expect(monthBuckets(from, to)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('dedupes hydrants seen in more than one month bucket and splits current vs overdue', () => {
    const section = summarizeHydrants(
      [
        { hydrantId: 'H1', nextFlowTestDue: '2026-03-01' },
        { hydrantId: 'H1', nextFlowTestDue: '2026-03-01' },
        { hydrantId: 'H2', nextFlowTestDue: '2026-01-15' },
      ],
      '2026-02-28',
    );
    expect(section.count).toBe(2);
    expect(section.currentCount).toBe(1);
    expect(section.overdueCount).toBe(1);
  });
});
