export type LogLevel = 'info' | 'warn' | 'error';

export interface LogFields {
  readonly event: string;
  readonly correlationId: string;
  readonly [key: string]: unknown;
}

export function logEvent(level: LogLevel, fields: LogFields): void {
  const line = JSON.stringify({ service: 'inventory-service', ...fields });
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function emitMetric(name: string, count = 1): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/InventoryService',
            Dimensions: [[]],
            Metrics: [{ Name: name, Unit: 'Count' }],
          },
        ],
      },
      [name]: count,
    }),
  );
}
