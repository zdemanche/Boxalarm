export type EmfUnit = 'Count' | 'Milliseconds';

export function emitEmf(
  namespace: string,
  metricName: string,
  value: number,
  dimensions: string[][],
  extra: Record<string, string> = {},
  unit: EmfUnit = 'Count',
): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: namespace,
            Dimensions: dimensions,
            Metrics: [{ Name: metricName, Unit: unit }],
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

/**
 * Runs `fn` and emits EMF Latency (Milliseconds), Throughput, and Errors —
 * shared wiring so services need not hand-roll request metrics.
 */
export async function withLatency<T>(
  namespace: string,
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - started;
    emitEmf(namespace, 'Latency', ms, [['Operation']], { Operation: operation }, 'Milliseconds');
    emitEmf(namespace, 'Throughput', 1, [['Operation']], { Operation: operation });
    return result;
  } catch (error) {
    const ms = Date.now() - started;
    emitEmf(namespace, 'Latency', ms, [['Operation']], { Operation: operation }, 'Milliseconds');
    emitEmf(namespace, 'Errors', 1, [['Operation']], { Operation: operation });
    throw error;
  }
}
