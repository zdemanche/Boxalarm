import { describe, expect, it, vi } from 'vitest';
import { emitInspectionMetric, type InspectionMetricOutcome } from './metrics.js';

describe('emitInspectionMetric', () => {
  it.each<InspectionMetricOutcome>([
    'Scheduled',
    'ScheduleFailed',
    'Conducted',
    'ConductFailed',
    'FieldCaptureSubmitted',
    'FieldCaptureDuplicate',
    'FieldCaptureFailed',
  ])('emits a well-formed EMF envelope for %s', (outcome) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    emitInspectionMetric(outcome);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0]![0] as string) as {
      _aws: {
        Timestamp: number;
        CloudWatchMetrics: {
          Namespace: string;
          Dimensions: unknown[][];
          Metrics: { Name: string; Unit: string }[];
        }[];
      };
      [key: string]: unknown;
    };
    const metricName = `Inspection${outcome}`;

    expect(typeof payload._aws.Timestamp).toBe('number');
    expect(payload._aws.CloudWatchMetrics).toEqual([
      {
        Namespace: 'Boxalarm/Inspections',
        Dimensions: [[]],
        Metrics: [{ Name: metricName, Unit: 'Count' }],
      },
    ]);
    expect(payload[metricName]).toBe(1);

    logSpy.mockRestore();
  });
});
