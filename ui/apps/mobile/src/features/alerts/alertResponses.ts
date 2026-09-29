import { kvDelete, kvGet, kvSet } from '../../sync/kvStore';
import * as syncManager from '../../sync/syncManager';
import { ackStatusLabel } from './ackStatus';
import type { AckStatus } from './types';

export type ResponseAnswer = Exclude<AckStatus, 'UNANSWERED'>;

/**
 * The alerting service requires an ETA for RESPONDING and DIRECT_TO_SCENE (responses/handler.ts
 * rejects a missing one with 400 - which the old fire-and-forget POST swallowed, so a member who
 * skipped the ETA field was never on the roster). One tap records the answer with this ETA; the
 * screen shows it as the selected chip and one more tap changes it.
 */
export const DEFAULT_ETA_MINUTES = 10;

export const ETA_CHOICES_MINUTES = [5, 10, 15, 20] as const;

/** This device's latest answer to a call, kept on the phone so re-opening the call shows it. */
export interface LocalAnswer {
  ackStatus: ResponseAnswer;
  etaMinutes: number | null;
  /** The outbox row carrying it; null when there is no API (the local mock repository). */
  outboxId: string | null;
  /** Epoch ms. */
  answeredAt: number;
}

const answerKey = (dispatchId: string) => `alert-answer:${dispatchId}`;

export async function getLocalAnswer(dispatchId: string): Promise<LocalAnswer | null> {
  return (await kvGet<LocalAnswer>(answerKey(dispatchId)))?.value ?? null;
}

export async function clearLocalAnswer(dispatchId: string): Promise<void> {
  await kvDelete(answerKey(dispatchId));
}

export async function saveLocalAnswer(dispatchId: string, answer: LocalAnswer): Promise<void> {
  await kvSet(answerKey(dispatchId), answer);
}

export function etaFor(ackStatus: ResponseAnswer, etaMinutes: number | undefined): number | null {
  if (ackStatus === 'NOT_RESPONDING') return null;
  return etaMinutes && etaMinutes > 0 ? etaMinutes : DEFAULT_ETA_MINUTES;
}

/** The POST body: eta is absolute epoch seconds, computed when the member answered - an answer
 * that waits in the queue for signal still means "N minutes from when I tapped". */
export function responseBody(
  ackStatus: ResponseAnswer,
  etaMinutes: number | null,
  now: number,
  clientAnswerId: string,
): Record<string, unknown> {
  return {
    ackStatus,
    eta: etaMinutes === null ? null : Math.floor(now / 1000) + etaMinutes * 60,
    assignedApparatusId: null,
    // Review CR-3: lets the server order two answers given within the same second and dedupe a
    // replay after a lost 200. Ignored by today's handler; the page-chain backend work uses it.
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
  etaMinutes: number | null,
  now: number = Date.now(),
): Promise<string> {
  const outboxId = `response-${dispatchId}-${now}`;
  const eta = etaMinutes === null ? '' : `, ETA ${etaMinutes} min`;
  await syncManager.enqueueResponse(
    outboxId,
    dispatchId,
    `Your response — ${ackStatusLabel(ackStatus)}${eta}`,
    responseBody(ackStatus, etaMinutes, now, outboxId),
  );
  await saveLocalAnswer(dispatchId, { ackStatus, etaMinutes, outboxId, answeredAt: now });
  return outboxId;
}
