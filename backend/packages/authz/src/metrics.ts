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

export function emitAuthzMetric(outcome: 'Allowed' | 'Denied', reason?: string): void {
  // Both dimension sets on a deny: [] so a plain deny-rate alarm resolves, and ['Reason']
  // so an outage is separable from a routine role denial. Mirrors emitAuthorizerMetric.
  emitEmf(
    'Boxalarm/authz',
    `Authz${outcome}`,
    reason ? [[], ['Reason']] : [[]],
    reason ? { Reason: reason } : {},
  );
}

export function emitInvocationMetric(name: string): void {
  // Unconditional, no-threshold counter — every invocation pages the chief per the
  // "Anomalous access monitoring" requirement, since no re-auth control exists behind it.
  emitEmf('Boxalarm/authz', name, [[]], {});
}
