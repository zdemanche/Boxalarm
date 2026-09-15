import { createLogger } from '@boxalarm/logging';

const logger = createLogger({ service: 'personnel-service' });

export function logInfo(
  event: string,
  correlationId: string,
  fields?: Record<string, unknown>,
): void {
  logger.info({ event, correlationId, ...fields });
}

export function logWarn(
  event: string,
  correlationId: string,
  fields?: Record<string, unknown>,
): void {
  logger.warn({ event, correlationId, ...fields });
}

export function logError(
  event: string,
  correlationId: string,
  error: unknown,
  fields?: Record<string, unknown>,
): void {
  logger.error({
    event,
    correlationId,
    message: error instanceof Error ? error.message : 'unknown error',
    ...fields,
  });
}
