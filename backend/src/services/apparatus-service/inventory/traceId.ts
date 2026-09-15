import { randomUUID } from 'node:crypto';

export function extractTraceId(headers: Record<string, string | undefined> | undefined): string {
  const traceparent = headers?.traceparent ?? headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}
