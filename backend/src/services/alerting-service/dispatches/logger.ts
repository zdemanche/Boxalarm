export type LogFields = Record<string, unknown>;

function emit(level: 'info' | 'error', event: string, fields: LogFields): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function logInfo(event: string, fields: LogFields = {}): void {
  emit('info', event, fields);
}

export function logError(event: string, error: unknown, fields: LogFields = {}): void {
  emit('error', event, {
    ...fields,
    message: error instanceof Error ? error.message : String(error),
  });
}
