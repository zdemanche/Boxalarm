export interface LogFields {
  readonly [key: string]: unknown;
}

function emit(
  sink: (line: string) => void,
  level: 'info' | 'warn' | 'error',
  event: string,
  correlationId: string,
  fields?: LogFields,
): void {
  sink(
    JSON.stringify({
      level,
      event,
      correlationId,
      service: 'personnel-service',
      ...fields,
    }),
  );
}

export function logInfo(event: string, correlationId: string, fields?: LogFields): void {
  emit(console.log, 'info', event, correlationId, fields);
}

export function logWarn(event: string, correlationId: string, fields?: LogFields): void {
  emit(console.warn, 'warn', event, correlationId, fields);
}

export function logError(
  event: string,
  correlationId: string,
  error: unknown,
  fields?: LogFields,
): void {
  emit(console.error, 'error', event, correlationId, {
    message: error instanceof Error ? error.message : 'unknown error',
    ...fields,
  });
}
