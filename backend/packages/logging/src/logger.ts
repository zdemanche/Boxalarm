import { redactPii } from './redact.js';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LoggerOptions {
  readonly service: string;
  /** Defaults to BOXALARM_ENV, then NODE_ENV, then "dev". */
  readonly env?: string;
}

export interface LogFields {
  readonly correlationId: string;
  readonly event: string;
  readonly [key: string]: unknown;
}

export interface Logger {
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

function resolveEnv(explicit?: string): string {
  return explicit ?? process.env.BOXALARM_ENV ?? process.env.NODE_ENV ?? 'dev';
}

export function createLogger(options: LoggerOptions): Logger {
  const service = options.service;

  function emit(level: LogLevel, fields: LogFields): void {
    const line = JSON.stringify(
      redactPii({
        ...fields,
        level,
        service,
        env: resolveEnv(options.env),
      }),
    );
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    info: (fields) => emit('info', fields),
    warn: (fields) => emit('warn', fields),
    error: (fields) => emit('error', fields),
  };
}
