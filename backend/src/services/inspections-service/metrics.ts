function emitEmf(metricName: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/Inspections',
            Dimensions: [[]],
            Metrics: [{ Name: metricName, Unit: 'Count' }],
          },
        ],
      },
      [metricName]: 1,
    }),
  );
}

export type InspectionMetricOutcome =
  | 'Scheduled'
  | 'ScheduleFailed'
  | 'Conducted'
  | 'ConductFailed'
  | 'FieldCaptureSubmitted'
  | 'FieldCaptureDuplicate'
  | 'FieldCaptureFailed';

export function emitInspectionMetric(outcome: InspectionMetricOutcome): void {
  emitEmf(`Inspection${outcome}`);
}
