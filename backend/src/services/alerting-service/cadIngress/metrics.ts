import { emitEmf } from '@boxalarm/metrics';

export const CAD_METRIC_NAMESPACE = 'Boxalarm/alerting-cad-ingress';

export type CadChannel = 'cad-email' | 'cad-webhook';

export type CadMetric =
  /** An authenticated dispatch was written (it pages through the stream fan-out). */
  | 'CadIngressAccepted'
  /** Authentication failed: dropped, never paged (Reason says which check). */
  | 'CadIngressAuthFailed'
  /** An authenticated-looking email too old to trust (Date > 60 min, DKIM t= > 10 min). */
  | 'CadIngressStale'
  /** Mail to an address no source owns (spam to the domain): dropped, not alarmed. */
  | 'CadIngressUnknownRecipient'
  /** A replayed webhook signature or email Message-ID/DKIM pair: dropped. */
  | 'CadIngressReplayRejected'
  /** A failed email kept in the mail bucket for review. */
  | 'CadIngressQuarantined'
  /** Refused before authentication for a non-trust reason (size) or a dependency outage. */
  | 'CadIngressRejected'
  /** Outcome PARSED or RAW (fail-open) for every accepted dispatch. */
  | 'CadIngressParsed'
  /** An accepted dispatch the source's template could not structure: paged as raw text. */
  | 'CadIngressRawFallback'
  /** A later message for an incident already paged, recorded as an update (no new page). */
  | 'CadIngressUpdated'
  /** The non-escalating UPDATE push was published to a dispatch's roster. */
  | 'CadUpdatePushPublished'
  /** The notifier found tone-1 fan-out still running and will retry (normal right after a page). */
  | 'CadUpdateWaitingForFanOut'
  /** Publishing an UPDATE push failed for at least one member (the record retries). */
  | 'CadUpdatePushFailed'
  /** A parser template ran past its deadline (or its worker failed): paged as RAW. */
  | 'CadParseTimeout'
  /** A CAD message older than the one already applied: history only, nothing pushed. */
  | 'CadIngressOlderMessage'
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
