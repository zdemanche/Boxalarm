import { emitEmf } from '@boxalarm/metrics';

export const CAD_METRIC_NAMESPACE = 'Boxalarm/alerting-cad-ingress';

export type CadChannel = 'cad-email' | 'cad-webhook';

export type CadMetric =
  /** An authenticated dispatch was written (it pages through the stream fan-out). */
  | 'CadIngressAccepted'
  /** Authentication failed: dropped, never paged (Reason says which check). */
  | 'CadIngressAuthFailed'
  /** A replayed webhook signature or email Message-ID/DKIM pair: dropped. */
  | 'CadIngressReplayRejected'
  /** A failed email kept in the mail bucket for review. */
  | 'CadIngressQuarantined'
  /** Refused before authentication for a non-trust reason (size) or a dependency outage. */
  | 'CadIngressRejected'
  /** Outcome PARSED or RAW (fail-open) for every accepted dispatch. */
  | 'CadIngressParsed'
  /** A CAD resend of a dispatch already written: not paged again. */
  | 'CadIngressDuplicate';

/**
 * One count, with the dimensionless set (what the alarms read) plus one set carrying every
 * given dimension, so a reason or channel can be broken out without fragmenting the alarm.
 */
export function emitCadMetric(name: CadMetric, dimensions: Record<string, string> = {}): void {
  const keys = Object.keys(dimensions);
  emitEmf(CAD_METRIC_NAMESPACE, name, 1, keys.length > 0 ? [[], keys] : [[]], dimensions);
}
