import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { useOutboxItem, type OutboxItemState } from '../../sync/useOutboxItem';
import { ackStatusLabel } from './ackStatus';
import { etaFor, getLocalAnswer, saveLocalAnswer, type ResponseAnswer } from './alertResponses';
import type { AlertsRepository } from './types';

/**
 * Where the member's answer actually is. Never "sent" while it is only on this phone.
 * - sending: saved, a send is in progress or about to start
 * - queued: saved, not sent - offline, or the last attempt failed and it will retry
 * - refused: the server rejected it (4xx); it will not retry by itself
 * - sent: the server accepted it (or, with no API configured, the local mock recorded it)
 * - unconfirmed: saved in an earlier session and no longer queued, but the server roster does
 *   not show it - resend to be sure
 * - unsaved: the phone could not even store it (storage failure) - nothing is on its way
 */
export type ResponseDelivery =
  'sending' | 'queued' | 'refused' | 'sent' | 'unconfirmed' | 'unsaved';

export interface MyAnswer {
  ackStatus: ResponseAnswer;
  etaMinutes: number | null;
}

export interface AlertResponseState {
  answer: MyAnswer | null;
  delivery: ResponseDelivery | null;
  outboxId: string | null;
  lastError: string | null;
  /** Records a new answer (a change is a new answer - the server keeps them append-only). */
  respond: (ackStatus: ResponseAnswer, etaMinutes?: number) => Promise<void>;
}

export function deliveryFor(
  outboxId: string | null,
  state: OutboxItemState,
  isOnline: boolean,
  serverConfirms: boolean,
): ResponseDelivery {
  if (outboxId === null) return 'sent';
  switch (state) {
    case 'QUEUED':
    case 'SYNCING':
      return isOnline ? 'sending' : 'queued';
    case 'FAILED':
      return 'queued';
    case 'REJECTED':
      return 'refused';
    case 'SYNCED':
      return 'sent';
    case 'DISCARDED':
    case 'NOT_QUEUED':
      return serverConfirms ? 'sent' : 'unconfirmed';
  }
}

function announce(message: string, assertive = false): void {
  if (assertive && Platform.OS === 'ios') {
    AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: false });
    return;
  }
  AccessibilityInfo.announceForAccessibility(message);
}

/** Spoken on each delivery change (a11y-spec §3.1 #4-#6). */
export function deliveryAnnouncement(answer: MyAnswer, delivery: ResponseDelivery): string {
  const what = ackStatusLabel(answer.ackStatus);
  switch (delivery) {
    case 'sending':
      return `${what}. Saved on this phone. Sending now.`;
    case 'queued':
      return `Couldn't reach the server. Your response, ${what}, is saved on this phone and will send automatically. Turn on cellular data or move to signal.`;
    case 'refused':
      return `The server refused your response, ${what}. Try again, or tell your officer by radio.`;
    case 'sent':
      return `Your response has been sent: ${what}. The officer can see it.`;
    case 'unconfirmed':
      return `Your response, ${what}, is not confirmed by the server. Tap it again to resend.`;
    case 'unsaved':
      return `Your response, ${what}, could not be saved on this phone and was not sent. Tap it again, or tell your officer by radio.`;
  }
}

/**
 * The member's answer to one call: this device's latest answer (kept on the phone, so re-opening
 * the call shows it), seeded from the server roster when this device has none, and its honest
 * delivery state from the outbox.
 */
export function useAlertResponse(
  repository: AlertsRepository,
  dispatchId: string,
  memberId: string | null,
  isOnline: boolean,
): AlertResponseState {
  const [local, setLocal] = useState<{
    answer: MyAnswer;
    outboxId: string | null;
    /** Tapped, not yet written to the outbox (a few ms). */
    saving: boolean;
    /** Answered in this screen visit - newer than the roster fetched on open. */
    fresh: boolean;
    /** The phone could not store it. */
    unsaved?: boolean;
  } | null>(null);
  const [server, setServer] = useState<MyAnswer | null>(null);
  const touchedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    touchedRef.current = false;
    setLocal(null);
    setServer(null);
    void getLocalAnswer(dispatchId).then((saved) => {
      if (cancelled || !saved || touchedRef.current) return;
      setLocal({
        answer: { ackStatus: saved.ackStatus, etaMinutes: saved.etaMinutes },
        outboxId: saved.outboxId,
        saving: false,
        fresh: false,
      });
    });
    if (memberId) {
      repository.getRoster(dispatchId).then(
        (roster) => {
          const mine = roster.find((entry) => entry.memberId === memberId);
          if (cancelled || !mine || mine.ackStatus === 'UNANSWERED') return;
          const etaMinutes =
            mine.eta && mine.ackStatus !== 'NOT_RESPONDING'
              ? Math.max(0, Math.round((mine.eta * 1000 - Date.now()) / 60_000))
              : null;
          setServer({ ackStatus: mine.ackStatus, etaMinutes });
        },
        () => {
          // The roster is a seed only: without it the screen still shows this device's answer.
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [dispatchId, memberId, repository]);

  const outboxId = local && !local.saving ? local.outboxId : null;
  const item = useOutboxItem(outboxId);
  const serverConfirms = Boolean(local && server && server.ackStatus === local.answer.ackStatus);

  let answer: MyAnswer | null = null;
  let delivery: ResponseDelivery | null = null;
  if (local?.unsaved) {
    answer = local.answer;
    delivery = 'unsaved';
  } else if (local?.saving) {
    answer = local.answer;
    delivery = isOnline ? 'sending' : 'queued';
  } else if (local) {
    delivery = deliveryFor(local.outboxId, item.state, isOnline, serverConfirms);
    // An answer saved in an earlier visit that is no longer in the queue has either been
    // delivered or dropped; if the roster (fetched on open, so newer than it) says otherwise -
    // answered again on another device, or this one never arrived - the roster is the truth,
    // because it is what the officer sees.
    const stillQueued =
      item.state === 'QUEUED' ||
      item.state === 'SYNCING' ||
      item.state === 'FAILED' ||
      item.state === 'REJECTED';
    if (!local.fresh && !stillQueued && server && !serverConfirms && local.outboxId !== null) {
      answer = server;
      delivery = 'sent';
    } else {
      answer = local.answer;
    }
  } else if (server) {
    answer = server;
    delivery = 'sent';
  }

  const lastAnnounced = useRef<string | null>(null);
  useEffect(() => {
    if (!touchedRef.current || !answer || !delivery) return;
    const message = deliveryAnnouncement(answer, delivery);
    if (message === lastAnnounced.current) return;
    lastAnnounced.current = message;
    announce(message, delivery === 'queued' || delivery === 'refused' || delivery === 'unsaved');
  }, [answer, delivery]);

  const respond = useCallback(
    async (ackStatus: ResponseAnswer, etaMinutes?: number) => {
      touchedRef.current = true;
      const eta = etaFor(ackStatus, etaMinutes);
      // Instant selected state (a11y-spec §3.1 #4) before anything touches storage or network.
      setLocal({
        answer: { ackStatus, etaMinutes: eta },
        outboxId: null,
        saving: true,
        fresh: true,
      });
      let result: { outboxId: string | null };
      try {
        result = await repository.submitResponse(dispatchId, ackStatus, eta ?? undefined);
      } catch (error) {
        console.error('[alert] saving a response failed; nothing was sent', error);
        setLocal({
          answer: { ackStatus, etaMinutes: eta },
          outboxId: null,
          saving: false,
          fresh: true,
          unsaved: true,
        });
        return;
      }
      if (result.outboxId === null) {
        await saveLocalAnswer(dispatchId, {
          ackStatus,
          etaMinutes: eta,
          outboxId: null,
          answeredAt: Date.now(),
        });
      }
      setLocal({
        answer: { ackStatus, etaMinutes: eta },
        outboxId: result.outboxId,
        saving: false,
        fresh: true,
      });
    },
    [dispatchId, repository],
  );

  return {
    answer,
    delivery,
    outboxId,
    lastError: item.lastError,
    respond,
  };
}
