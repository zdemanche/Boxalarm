export interface TrainingHoursSection {
  readonly totalHours: number;
  readonly categories: readonly { readonly category: string; readonly totalHours: number }[];
}

export interface ApparatusTestsSection {
  readonly byType: readonly {
    readonly testType: string;
    readonly passCount: number;
    readonly failCount: number;
  }[];
}

export interface HydrantFlowSection {
  readonly count: number;
  readonly currentCount: number;
  readonly overdueCount: number;
  readonly hydrants: readonly {
    readonly hydrantId: string;
    readonly nextFlowTestDue: string;
    readonly current: boolean;
  }[];
}

export const EMPTY_TRAINING: TrainingHoursSection = { totalHours: 0, categories: [] };
export const EMPTY_APPARATUS: ApparatusTestsSection = { byType: [] };
export const EMPTY_HYDRANTS: HydrantFlowSection = {
  count: 0,
  currentCount: 0,
  overdueCount: 0,
  hydrants: [],
};

export function monthBuckets(fromEpochSeconds: number, toEpochSeconds: number): readonly string[] {
  const start = new Date(fromEpochSeconds * 1000);
  const end = new Date(toEpochSeconds * 1000);
  const months: string[] = [];
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  const endYear = end.getUTCFullYear();
  const endMonth = end.getUTCMonth();
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month + 1).padStart(2, '0')}`);
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return months;
}

export function epochToIsoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export function summarizeTrainingHours(
  records: readonly { readonly category: string; readonly hours: number }[],
): TrainingHoursSection {
  const totals = new Map<string, number>();
  for (const record of records) {
    const category =
      record.category.trim().length > 0 ? record.category.trim().toUpperCase() : 'UNCATEGORIZED';
    totals.set(category, (totals.get(category) ?? 0) + record.hours);
  }
  const categories = [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, totalHours]) => ({ category, totalHours }));
  return {
    totalHours: categories.reduce((sum, category) => sum + category.totalHours, 0),
    categories,
  };
}

export function summarizeApparatusTests(
  records: readonly { readonly testType: string; readonly result: string }[],
): ApparatusTestsSection {
  const byType = new Map<string, { passCount: number; failCount: number }>();
  for (const record of records) {
    const current = byType.get(record.testType) ?? { passCount: 0, failCount: 0 };
    if (record.result === 'PASS') {
      current.passCount += 1;
    } else if (record.result === 'FAIL') {
      current.failCount += 1;
    }
    byType.set(record.testType, current);
  }
  return {
    byType: [...byType.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([testType, counts]) => ({ testType, ...counts })),
  };
}

export function summarizeHydrants(
  records: readonly { readonly hydrantId: string; readonly nextFlowTestDue: string }[],
  periodEndDate: string,
): HydrantFlowSection {
  const byId = new Map<string, { hydrantId: string; nextFlowTestDue: string }>();
  for (const record of records) {
    byId.set(record.hydrantId, record);
  }
  const hydrants = [...byId.values()]
    .map((hydrant) => ({
      ...hydrant,
      current: hydrant.nextFlowTestDue >= periodEndDate,
    }))
    .sort((a, b) => a.hydrantId.localeCompare(b.hydrantId));
  return {
    count: hydrants.length,
    currentCount: hydrants.filter((hydrant) => hydrant.current).length,
    overdueCount: hydrants.filter((hydrant) => !hydrant.current).length,
    hydrants,
  };
}
