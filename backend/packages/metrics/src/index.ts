export function emitEmf(
  namespace: string,
  metricName: string,
  value: number,
  dimensions: string[][],
  extra: Record<string, string> = {},
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
      [metricName]: value,
    }),
  );
}

export function emitOutcomeMetric(namespace: string, metricName: string, reason?: string): void {
  // Dual dimension-set pattern (mirrors packages/authz/src/metrics.ts): [] keeps a plain
  // rate alarm resolvable, ['Reason'] separates causes without fragmenting the plain count.
  emitEmf(
    namespace,
    metricName,
    1,
    reason ? [[], ['Reason']] : [[]],
    reason ? { Reason: reason } : {},
  );
}
