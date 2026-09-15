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

export type InventoryOperation = 'List' | 'Create' | 'Update';
export type InventoryOutcome = 'Success' | 'Failure';

export function emitInventoryMetric(
  operation: InventoryOperation,
  outcome: InventoryOutcome,
  reason?: string,
): void {
  // Both dimension sets on a failure: [] so a plain failure-rate alarm resolves, and
  // ['Reason'] so a DynamoDB outage is separable from a 404. Mirrors emitAuthzMetric.
  emitEmf(
    'Boxalarm/Apparatus',
    `Inventory${operation}${outcome}`,
    reason ? [[], ['Reason']] : [[]],
    reason ? { Reason: reason } : {},
  );
}
