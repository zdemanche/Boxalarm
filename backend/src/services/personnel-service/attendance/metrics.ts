function emitEmf(
  namespace: string,
  metricName: string,
  dimensions: string[][],
  extra: Record<string, string>,
): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: namespace,
            Dimensions: dimensions,
            Metrics: [{ Name: metricName, Unit: 'Count' }],
          },
        ],
      },
      ...extra,
      [metricName]: 1,
    }),
  );
}

export function emitAttendanceMetric(outcome: 'Recorded' | 'Failed', reason?: string): void {
  emitEmf(
    'Boxalarm/personnel',
    `Attendance${outcome}`,
    reason ? [[], ['Reason']] : [[]],
    reason ? { Reason: reason } : {},
  );
}
