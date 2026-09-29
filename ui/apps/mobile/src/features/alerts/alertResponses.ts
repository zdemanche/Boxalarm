import Config from 'react-native-config';
import { kvDelete, kvGet, kvSet } from '../../sync/kvStore';
import * as syncManager from '../../sync/syncManager';
import { ackStatusLabel } from './ackStatus';
import type { AckStatus } from './types';

export type ResponseAnswer = Exclude<AckStatus, 'UNANSWERED'>;

/** "20+" is "at least 20"; "At station" is already there (minutes 0). */
export type EtaQualifier = 'AT_LEAST' | 'AT_STATION';

/** An ETA the member actually chose. A one-tap or notification answer has none (null). */
export interface EtaGiven {
  minutes: number;
  qualifier: EtaQualifier | null;
}

export interface EtaChoice extends EtaGiven {
  id: string;
  label: string;
  /** Accessible name. */
  spoken: string;
}

// Review MJ-1 / design review M2: optional chips, including "20+" and "At station".
export const ETA_CHOICES: readonly EtaChoice[] = [
  { id: '5', label: '5', spoken: 'ETA 5 minutes', minutes: 5, qualifier: null },
  { id: '10', label: '10', spoken: 'ETA 10 minutes', minutes: 10, qualifier: null },
  { id: '15', label: '15', spoken: 'ETA 15 minutes', minutes: 15, qualifier: null },
  { id: '20+', label: '20+', spoken: 'ETA 20 minutes or more', minutes: 20, qualifier: 'AT_LEAST' },
  {
    id: 'AT_STATION',
    label: 'At station',
    spoken: 'Already at the station',
    minutes: 0,
    qualifier: 'AT_STATION',
  },
];

export function sameEta(a: EtaGiven | null, b: EtaGiven | null): boolean {
  if (!a || !b) return a === b;
  return a.minutes === b.minutes && (a.qualifier ?? null) === (b.qualifier ?? null);
}

/** "ETA ?", "ETA 10 min", "ETA 20+ min", "at station" - never a number the member did not pick. */
export function formatEta(eta: EtaGiven | null): string {
  if (!eta) return 'ETA ?';
  if (eta.qualifier === 'AT_STATION') return 'at station';
  return `ETA ${eta.minutes}${eta.qualifier === 'AT_LEAST' ? '+' : ''} min`;
}

/**
 * Whether the alerting service accepts `eta: null` for RESPONDING / DIRECT_TO_SCENE. Today's
 * handler rejects it with 400, so until the page-chain backend change ships (and this flag is set
 * in the build's .env) an answer with no chosen ETA still has to carry a placeholder - and it is
 * sent with `etaSource: 'NOT_GIVEN'` so the server can tell it apart. The phone never shows the
 * placeholder: it shows "ETA ?".
 */
export function serverAcceptsMissingEta(): boolean {
  return Config.RESPONSE_ETA_OPTIONAL === 'true';
}

/** Placeholder sent only while the server still requires an ETA (see serverAcceptsMissingEta). */
export const LEGACY_PLACEHOLDER_ETA_MINUTES = 10;

/** This device's latest answer to a call, kept on the phone so re-opening the call shows it. */
export interface LocalAnswer {
  ackStatus: ResponseAnswer;
  eta: EtaGiven | null;
  /** The outbox row carrying it; null when there is no API (the local mock repository). */
  outboxId: string | null;
  /** Epoch ms. */
  answeredAt: number;
}

const answerKey = (dispatchId: string) => `alert-answer:${dispatchId}`;

export async function getLocalAnswer(dispatchId: string): Promise<LocalAnswer | null> {
  const stored = (await kvGet<LocalAnswer & { etaMinutes?: number | null }>(answerKey(dispatchId)))
    ?.value;
  if (!stored) return null;
  // Written by an earlier build as { etaMinutes }.
  if (stored.eta === undefined) {
    const { etaMinutes, ...rest } = stored;
    return { ...rest, eta: etaMinutes ? { minutes: etaMinutes, qualifier: null } : null };
  }
  return stored;
}

export async function clearLocalAnswer(dispatchId: string): Promise<void> {
  await kvDelete(answerKey(dispatchId));
}

export async function saveLocalAnswer(dispatchId: string, answer: LocalAnswer): Promise<void> {
  await kvSet(answerKey(dispatchId), answer);
}

/** A Not responding answer never carries an ETA. */
export function etaFor(
  ackStatus: ResponseAnswer,
  eta: EtaGiven | null | undefined,
): EtaGiven | null {
  return ackStatus === 'NOT_RESPONDING' ? null : (eta ?? null);
}

/**
 * The POST body. eta is absolute epoch seconds from the moment the member answered (an answer
 * that waits in the queue still means "N minutes from when I tapped"), or null when none was
 * chosen and the server accepts that. etaSource / etaQualifier / clientAnswerId / answeredAtMs
 * are ignored by today's handler; the page-chain backend work reads them.
 */
export function responseBody(
  ackStatus: ResponseAnswer,
  eta: EtaGiven | null,
  now: number,
  clientAnswerId: string,
  acceptsMissingEta: boolean = serverAcceptsMissingEta(),
): Record<string, unknown> {
  const nowSeconds = Math.floor(now / 1000);
  let etaSeconds: number | null = null;
  if (ackStatus !== 'NOT_RESPONDING') {
    if (eta) etaSeconds = nowSeconds + eta.minutes * 60;
    else if (!acceptsMissingEta) etaSeconds = nowSeconds + LEGACY_PLACEHOLDER_ETA_MINUTES * 60;
  }
  return {
    ackStatus,
    eta: etaSeconds,
    assignedApparatusId: null,
    etaSource: ackStatus === 'NOT_RESPONDING' ? null : eta ? 'MEMBER' : 'NOT_GIVEN',
    etaQualifier: eta?.qualifier ?? null,
    // Review CR-3: lets the server order two answers given within the same second and dedupe a
    // replay after a lost 200.
    clientAnswerId,
    answeredAtMs: now,
  };
}

/**
 * Puts one answer on the phone (SQLite outbox, survives app kill) and starts sending it. Resolves
 * once it is saved - never waits on the network; the delivery state is read from the outbox.
 * Used by the alert screen and by the notification actions, so both take the same path.
 */
export async function queueAlertResponse(
  dispatchId: string,
  ackStatus: ResponseAnswer,
  eta: EtaGiven | null,
  now: number = Date.now(),
): Promise<string> {
  const outboxId = `response-${dispatchId}-${now}`;
  const given = etaFor(ackStatus, eta);
  const etaText = ackStatus === 'NOT_RESPONDING' ? '' : `, ${formatEta(given)}`;
  await syncManager.enqueueResponse(
    outboxId,
    dispatchId,
    `Your response — ${ackStatusLabel(ackStatus)}${etaText}`,
    responseBody(ackStatus, given, now, outboxId),
  );
  await saveLocalAnswer(dispatchId, { ackStatus, eta: given, outboxId, answeredAt: now });
  return outboxId;
}
