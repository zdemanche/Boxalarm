import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import {
  RESPONSE_NOT_RECORDED,
  RESPONSE_SUPERSEDED,
  SIGN_IN_REJECTED,
} from '../../sync/syncManager';
import { useOutboxItem, type OutboxItemState } from '../../sync/useOutboxItem';
import { ackStatusLabel } from './ackStatus';
import {
  clearLocalAnswer,
  etaFor,
  getLocalAnswer,
  saveLocalAnswer,
  type EtaGiven,
  type ResponseAnswer,
} from './alertResponses';
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
 * - notRecorded: the server answered 409 with a code other than SUPERSEDED - the answer is not
 *   on the roster; resend to be sure
 * - superseded: 409 SUPERSEDED - recorded, but a newer answer (maybe another device's) is the
 *   one on the roster; both are shown
 * - disputed: the officer's roster shows a different answer from this phone's last one; both
 *   are shown, never silently swapped
 */
export type ResponseDelivery =
  | 'sending'
  | 'queued'
  | 'refused'
  | 'sent'
  | 'unconfirmed'
  | 'unsaved'
  | 'notRecorded'
  | 'disputed'
  | 'signInRejected'
  | 'notConnected'
  | 'superseded';

export interface MyAnswer {
  ackStatus: ResponseAnswer;
  /** Only an ETA the member chose (or the roster's); null shows as "ETA ?". */
  eta: EtaGiven | null;
}

export interface AlertResponseState {
  answer: MyAnswer | null;
  delivery: ResponseDelivery | null;
  outboxId: string | null;
  lastError: string | null;
  /** What the officer's roster shows, when it disagrees with this phone's answer. */
  rosterAnswer: MyAnswer | null;
  /** Records a new answer (a change is a new answer - the server keeps them append-only). */
  respond: (ackStatus: ResponseAnswer, eta?: EtaGiven | null) => Promise<void>;
  /** Accept the roster's answer as this phone's (drops the phone's disagreeing record). */
  keepRosterAnswer: () => Promise<void>;
}

export function deliveryFor(
  outboxId: string | null,
  state: OutboxItemState,
  isOnline: boolean,
  serverConfirms: boolean,
  lastError: string | null = null,
): ResponseDelivery {
  // No outbox row means no API was configured (the local fixture repository): nothing was sent
  // to anyone, whatever the fixture recorded (review m10).
  if (outboxId === null) return 'notConnected';
  switch (state) {
    case 'QUEUED':
    case 'SYNCING':
      return isOnline ? 'sending' : 'queued';
    case 'FAILED':
      return lastError === SIGN_IN_REJECTED ? 'signInRejected' : 'queued';
    case 'REJECTED':
      return lastError === RESPONSE_SUPERSEDED
        ? 'superseded'
        : lastError === RESPONSE_NOT_RECORDED
          ? 'notRecorded'
          : 'refused';
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
      return `Your response has been sent: ${what}.`;
    case 'unconfirmed':
      return `Your response, ${what}, is not confirmed by the server. Tap it again to resend.`;
    case 'unsaved':
      return `Your response, ${what}, could not be saved on this phone and was not sent. Tap it again, or tell your officer by radio.`;
    case 'notRecorded':
      return `Your change to ${what} did not reach the officer's roster. Send it again, or tell your officer by radio.`;
    case 'disputed':
      return `The officer's roster does not show your answer, ${what}. Send it again or keep what the roster shows.`;
    case 'superseded':
      return `A newer answer is already on the officer's roster, not your ${what}. Send yours again, or keep the roster's.`;
    case 'notConnected':
      return `Your response, ${what}, was not sent: this phone is not connected to a Boxalarm server. Tell your officer by radio.`;
    case 'signInRejected':
      return `Your response, ${what}, is not sent: the server did not accept this phone's sign-in. It keeps retrying. Tell your officer by radio.`;
  }
}

/**
 * The member's answer to one call: this device's latest answer (kept on the phone, so re-opening
 * the call shows it), seeded from the server roster when this device has none, and its honest
 * delivery state from the outbox.
 */
/**
 * A roster ETA (absolute epoch seconds) read back as what the member sees. "At station" is sent
 * as eta = the moment of answering, so one that is due within a minute (or past) reads "At
 * station", never "ETA 0 min" (round 2 m2-5). The roster carries no qualifier, so 20+ reads as
 * its minutes.
 */
export function rosterEta(etaSeconds: number, nowMs: number): EtaGiven {
  const minutes = Math.round((etaSeconds * 1000 - nowMs) / 60_000);
  if (minutes <= 1) return { minutes: 0, qualifier: 'AT_STATION' };
  return { minutes, qualifier: null };
}

/** Lets the roster's own write settle before it is read back to check an answer. */
export const ROSTER_VERIFY_DELAY_MS = 1_500;

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
  const [server, setServer] = useState<{ answer: MyAnswer; checkedAfter: string | null } | null>(
    null,
  );
  const touchedRef = useRef(false);

  const loadRoster = useCallback(
    async (checkedAfter: string | null): Promise<void> => {
      if (!memberId) return;
      try {
        const roster = await repository.getRoster(dispatchId);
        const mine = roster.find((entry) => entry.memberId === memberId);
        if (!mine || mine.ackStatus === 'UNANSWERED') return;
        const eta: EtaGiven | null =
          mine.eta && mine.ackStatus !== 'NOT_RESPONDING' ? rosterEta(mine.eta, Date.now()) : null;
        setServer({ answer: { ackStatus: mine.ackStatus, eta }, checkedAfter });
      } catch {
        // The roster is a check only: without it the screen still shows this device's answer.
      }
    },
    [dispatchId, memberId, repository],
  );

  useEffect(() => {
    let cancelled = false;
    touchedRef.current = false;
    setLocal(null);
    setServer(null);
    void getLocalAnswer(dispatchId).then((saved) => {
      if (cancelled || !saved || touchedRef.current) return;
      setLocal({
        answer: { ackStatus: saved.ackStatus, eta: saved.eta },
        outboxId: saved.outboxId,
        saving: false,
        fresh: false,
      });
    });
    void loadRoster(null);
    return () => {
      cancelled = true;
    };
  }, [dispatchId, loadRoster]);

  const outboxId = local && !local.saving ? local.outboxId : null;
  const item = useOutboxItem(outboxId);
  const serverConfirms = Boolean(
    local && server && server.answer.ackStatus === local.answer.ackStatus,
  );

  // Review CR-3: belt and braces. The page-chain server reports an answer that is not current as
  // 409; a server without that change could drop a same-second change while answering 200. Once
  // an answer this visit is delivered, re-read the member's own roster row after a short settle
  // and compare.
  const verifiedRef = useRef<string | null>(null);
  useEffect(() => {
    if (item.state !== 'SYNCED' || !outboxId || verifiedRef.current === outboxId) return;
    verifiedRef.current = outboxId;
    const timer = setTimeout(() => void loadRoster(outboxId), ROSTER_VERIFY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [item.state, outboxId, loadRoster]);

  // A 409 SUPERSEDED names a newer answer on the roster: fetch it so the member sees what it is.
  const supersededFetchRef = useRef<string | null>(null);
  useEffect(() => {
    if (item.state !== 'REJECTED' || item.lastError !== RESPONSE_SUPERSEDED || !outboxId) return;
    if (supersededFetchRef.current === outboxId) return;
    supersededFetchRef.current = outboxId;
    void loadRoster(outboxId);
  }, [item.state, item.lastError, outboxId, loadRoster]);

  let answer: MyAnswer | null = null;
  let delivery: ResponseDelivery | null = null;
  let rosterAnswer: MyAnswer | null = null;
  if (local?.unsaved) {
    answer = local.answer;
    delivery = 'unsaved';
  } else if (local?.saving) {
    answer = local.answer;
    delivery = isOnline ? 'sending' : 'queued';
  } else if (local) {
    answer = local.answer;
    delivery = deliveryFor(local.outboxId, item.state, isOnline, serverConfirms, item.lastError);
    const stillQueued =
      item.state === 'QUEUED' ||
      item.state === 'SYNCING' ||
      item.state === 'FAILED' ||
      item.state === 'REJECTED';
    // The roster disagrees with an answer that has left the queue: either it was read after this
    // visit's answer was delivered, or this is an answer from an earlier visit. Show both -
    // never silently adopt one (the member may have answered on another device, or this answer
    // never reached the roster).
    const rosterIsCurrent = !local.fresh || server?.checkedAfter === local.outboxId;
    if (delivery === 'superseded') {
      rosterAnswer = server?.answer ?? null;
    } else if (
      !stillQueued &&
      server &&
      !serverConfirms &&
      rosterIsCurrent &&
      local.outboxId !== null
    ) {
      delivery = 'disputed';
      rosterAnswer = server.answer;
    }
  } else if (server) {
    answer = server.answer;
    delivery = 'sent';
  }

  const lastAnnounced = useRef<string | null>(null);
  useEffect(() => {
    if (!touchedRef.current || !answer || !delivery) return;
    const message = deliveryAnnouncement(answer, delivery);
    if (message === lastAnnounced.current) return;
    lastAnnounced.current = message;
    announce(
      message,
      delivery === 'queued' ||
        delivery === 'refused' ||
        delivery === 'unsaved' ||
        delivery === 'notRecorded' ||
        delivery === 'disputed' ||
        delivery === 'signInRejected' ||
        delivery === 'notConnected' ||
        delivery === 'superseded',
    );
  }, [answer, delivery]);

  const respond = useCallback(
    async (ackStatus: ResponseAnswer, chosenEta?: EtaGiven | null) => {
      touchedRef.current = true;
      const eta = etaFor(ackStatus, chosenEta);
      // Instant selected state (a11y-spec §3.1 #4) before anything touches storage or network.
      setLocal({
        answer: { ackStatus, eta },
        outboxId: null,
        saving: true,
        fresh: true,
      });
      let result: { outboxId: string | null };
      try {
        result = await repository.submitResponse(dispatchId, ackStatus, eta);
      } catch (error) {
        console.error('[alert] saving a response failed; nothing was sent', error);
        setLocal({
          answer: { ackStatus, eta },
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
          eta,
          outboxId: null,
          answeredAt: Date.now(),
        });
      }
      setLocal({
        answer: { ackStatus, eta },
        outboxId: result.outboxId,
        saving: false,
        fresh: true,
      });
    },
    [dispatchId, repository],
  );

  const keepRosterAnswer = useCallback(async () => {
    await clearLocalAnswer(dispatchId);
    setLocal(null);
  }, [dispatchId]);

  return {
    answer,
    delivery,
    outboxId,
    lastError: item.lastError,
    rosterAnswer,
    respond,
    keepRosterAnswer,
  };
}
