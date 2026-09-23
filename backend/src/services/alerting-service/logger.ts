import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function logError(fields: Record<string, unknown>): void {
  logger.error(fields);
}

export function logInfo(fields: Record<string, unknown>): void {
  logger.info(fields);
}
