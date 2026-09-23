function emitEmf(metricName: string, reason?: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/inventory',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: metricName, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [metricName]: 1,
    }),
  );
}

export function emitInventoryMetric(
  outcome: 'AssetLifecycleTransitioned' | 'AssetLifecycleTransitionFailed',
  reason?: string,
): void {
  emitEmf(outcome, reason);
}
