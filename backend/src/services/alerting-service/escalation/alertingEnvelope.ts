import { randomUUID } from 'node:crypto';

const SOURCE = 'alerting-service';
const SCHEMA_VERSION = '1.0';

export interface AlertingEnvelope<TPayload> {
  readonly eventId: string;
  readonly eventTime: string;
  readonly eventType: string;
  readonly source: typeof SOURCE;
  readonly correlationId: string;
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly payload: TPayload;
}

/**
 * Builds the standard alerting-service SNS event envelope
 * ({eventId, eventTime, eventType, source, correlationId, schemaVersion, payload}). Shared by
 * every publisher in this directory to avoid hand-rolling the same envelope verbatim per call
 * site.
 */
export function buildAlertingEnvelope<TPayload>(
  eventType: string,
  correlationId: string,
  payload: TPayload,
): AlertingEnvelope<TPayload> {
  return {
    eventId: randomUUID(),
    eventTime: new Date().toISOString(),
    eventType,
    source: SOURCE,
    correlationId,
    schemaVersion: SCHEMA_VERSION,
    payload,
  };
}
