import pino from 'pino';

export const logger = pino({ name: 'reporting-service' });

export function logError(
  event: string,
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  logger.error({
    event,
    ...context,
    reason: error instanceof Error ? error.constructor.name : 'UnknownError',
    message: error instanceof Error ? error.message : undefined,
  });
}
