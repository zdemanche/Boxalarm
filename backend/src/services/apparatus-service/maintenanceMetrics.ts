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

export function emitMaintenanceMetric(outcome: 'Logged' | 'LogFailed'): void {
  emitEmf('Boxalarm/apparatus', `MaintenanceRecord${outcome}`, [[]], {});
}
