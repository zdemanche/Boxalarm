export interface LogFields {
  readonly event: string;
  readonly service: string;
  readonly correlationId: string;
  readonly [key: string]: unknown;
}

export function logInfo(fields: LogFields): void {
  process.stdout.write(`${JSON.stringify(fields)}\n`);
}

export function logError(fields: LogFields): void {
  process.stderr.write(`${JSON.stringify(fields)}\n`);
}
