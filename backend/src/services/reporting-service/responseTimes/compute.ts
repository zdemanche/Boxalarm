/**
 * App-side percentile (architecture §7): per-department incident volume stays in the
 * low hundreds per year, so turnout/travel/total percentiles are interpolated in
 * process rather than pushed into the database.
 * Linear interpolation: rank = (p / 100) * (n - 1) on the sorted sample.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) {
    return sorted[0] ?? null;
  }
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const low = sorted[lower];
  const high = sorted[upper];
  if (low === undefined || high === undefined) {
    return null;
  }
  if (lower === upper) {
    return low;
  }
  const weight = rank - lower;
  return low * (1 - weight) + high * weight;
}

export interface ResponseUnitSample {
  readonly incidentId: string;
  readonly unitId: string;
  readonly dispatchedAt?: number;
  readonly enRouteAt?: number;
  readonly arrivedAt?: number;
}

export interface UnitResponseTimes {
  readonly incidentId: string;
  readonly unitId: string;
  readonly turnoutSeconds: number | null;
  readonly travelSeconds: number | null;
  readonly totalSeconds: number | null;
}

export interface TimeSummary {
  readonly medianSeconds: number | null;
  readonly p90Seconds: number | null;
  readonly sampleCount: number;
  readonly excludedCount: number;
}

export interface ResponseTimeAnalytics {
  readonly units: readonly UnitResponseTimes[];
  readonly turnout: TimeSummary;
  readonly travel: TimeSummary;
  readonly total: TimeSummary;
}

function elapsed(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined || end < start) {
    return undefined;
  }
  return end - start;
}

function summarize(values: readonly number[], excludedCount: number): TimeSummary {
  return {
    medianSeconds: percentile(values, 50),
    p90Seconds: percentile(values, 90),
    sampleCount: values.length,
    excludedCount,
  };
}

export function computeResponseTimeAnalytics(
  samples: readonly ResponseUnitSample[],
): ResponseTimeAnalytics {
  const units: UnitResponseTimes[] = [];
  const turnout: number[] = [];
  const travel: number[] = [];
  const total: number[] = [];
  let turnoutExcluded = 0;
  let travelExcluded = 0;
  let totalExcluded = 0;

  for (const sample of samples) {
    const turnoutSeconds = elapsed(sample.dispatchedAt, sample.enRouteAt);
    const travelSeconds = elapsed(sample.enRouteAt, sample.arrivedAt);
    const totalSeconds = elapsed(sample.dispatchedAt, sample.arrivedAt);
    if (turnoutSeconds === undefined) {
      turnoutExcluded += 1;
    } else {
      turnout.push(turnoutSeconds);
    }
    if (travelSeconds === undefined) {
      travelExcluded += 1;
    } else {
      travel.push(travelSeconds);
    }
    if (totalSeconds === undefined) {
      totalExcluded += 1;
    } else {
      total.push(totalSeconds);
    }
    units.push({
      incidentId: sample.incidentId,
      unitId: sample.unitId,
      turnoutSeconds: turnoutSeconds ?? null,
      travelSeconds: travelSeconds ?? null,
      totalSeconds: totalSeconds ?? null,
    });
  }

  return {
    units,
    turnout: summarize(turnout, turnoutExcluded),
    travel: summarize(travel, travelExcluded),
    total: summarize(total, totalExcluded),
  };
}
