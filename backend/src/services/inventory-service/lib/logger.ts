import { createLogger, type LogFields as SharedLogFields, type LogLevel } from '@boxalarm/logging';
import { emitOutcomeMetric } from '@boxalarm/metrics';

export type { LogLevel };
export type LogFields = SharedLogFields;

const logger = createLogger({ service: 'inventory-service' });

export function logEvent(level: LogLevel, fields: LogFields): void {
  logger[level](fields);
}

export function emitMetric(name: string, count = 1): void {
  // ponytail: count>1 callers don't exist yet; OutcomeMetric is count=1
  void count;
  emitOutcomeMetric('Boxalarm/InventoryService', name);
}
