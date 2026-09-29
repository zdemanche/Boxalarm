import { spacing, typeScale, type StatusRole } from '@boxalarm/design-tokens';
import { Text, View } from 'react-native';
import { Button, StatusChip, useTheme } from '../../components/ui';
import * as syncManager from '../../sync/syncManager';
import { ackStatusLabel } from './ackStatus';
import { formatEta } from './alertResponses';
import type { MyAnswer, ResponseDelivery } from './useAlertResponse';

interface Copy {
  role: StatusRole;
  chip: string;
  detail: string;
  /** Short phrase appended to the selected button's accessible name (a11y-spec §3.1 #5). */
  spoken: string;
}

export function responseDeliveryCopy(delivery: ResponseDelivery): Copy {
  switch (delivery) {
    case 'sending':
      return {
        role: 'info',
        chip: 'Sending',
        detail: 'Saved on this phone. Sending now.',
        spoken: 'saved, sending',
      };
    case 'queued':
      return {
        role: 'warning',
        chip: 'Not sent yet',
        detail:
          'Saved on this phone - the officer cannot see it yet. It sends automatically when you have signal.',
        spoken: 'queued, not yet sent',
      };
    case 'refused':
      return {
        role: 'danger',
        chip: 'Refused by server',
        detail: 'The server refused this answer. Send it again, or tell your officer by radio.',
        spoken: 'refused by the server, not recorded',
      };
    case 'sent':
      return {
        role: 'ok',
        chip: 'Sent',
        detail: 'Received by Boxalarm.',
        spoken: 'sent',
      };
    case 'unconfirmed':
      return {
        role: 'caution',
        chip: 'Not confirmed',
        detail: 'The server does not show this answer. Send it again to be sure.',
        spoken: 'not confirmed by the server',
      };
    case 'unsaved':
      return {
        role: 'danger',
        chip: 'Not saved',
        detail: 'This phone could not save your answer, so nothing was sent. Tap it again.',
        spoken: 'not saved, not sent',
      };
    case 'notRecorded':
      return {
        role: 'danger',
        chip: 'Not on the roster',
        detail:
          "The server got this answer but did not put it on the officer's roster. Send it again, or tell your officer by radio.",
        spoken: "not recorded on the officer's roster",
      };
    case 'disputed':
      return {
        role: 'danger',
        chip: 'Roster shows something else',
        detail: "The officer's roster does not show this answer.",
        spoken: "the officer's roster shows a different answer",
      };
  }
}

interface ResponseStatusProps {
  answer: MyAnswer;
  delivery: ResponseDelivery;
  outboxId: string | null;
  lastError: string | null;
  /** The roster's answer when it disagrees (delivery 'disputed'). */
  rosterAnswer?: MyAnswer | null;
  onResend: () => void;
  onKeepRoster?: () => void;
}

function describeAnswer(answer: MyAnswer): string {
  const eta = answer.ackStatus === 'NOT_RESPONDING' ? '' : `, ${formatEta(answer.eta)}`;
  return `${ackStatusLabel(answer.ackStatus)}${eta}`;
}

/** "Your response" block: what was answered and exactly where it is - never "sent" while it is
 * still only on this phone (alert-ux C2). */
export function ResponseStatus({
  answer,
  delivery,
  outboxId,
  lastError,
  rosterAnswer,
  onResend,
  onKeepRoster,
}: ResponseStatusProps) {
  const theme = useTheme();
  const copy = responseDeliveryCopy(delivery);
  const eta = answer.ackStatus === 'NOT_RESPONDING' ? '' : ` · ${formatEta(answer.eta)}`;
  const canResend =
    delivery === 'refused' ||
    delivery === 'unconfirmed' ||
    delivery === 'unsaved' ||
    delivery === 'notRecorded' ||
    delivery === 'disputed';

  return (
    <View accessibilityLiveRegion="polite" style={{ gap: spacing.sm }}>
      <Text style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '700' }}>
        Your response: {ackStatusLabel(answer.ackStatus)}
        {eta}
      </Text>
      <StatusChip status={copy.role} label={copy.chip} />
      <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>{copy.detail}</Text>
      {delivery === 'disputed' && rosterAnswer ? (
        <Text style={{ color: theme.fg, fontSize: typeScale.body.size, fontWeight: '700' }}>
          Roster shows: {describeAnswer(rosterAnswer)}. Your last answer from this phone:{' '}
          {describeAnswer(answer)}.
        </Text>
      ) : null}
      {delivery === 'queued' && lastError ? (
        <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
          Last attempt: {lastError}
        </Text>
      ) : null}
      {delivery === 'refused' && lastError ? (
        <Text style={{ color: theme.status.danger, fontSize: typeScale.body.size }}>
          {lastError}
        </Text>
      ) : null}
      {delivery === 'queued' && outboxId ? (
        <Button
          label="Try sending now"
          variant="secondary"
          size="alert"
          accessibilityLabel="Try sending your response now"
          onPress={() => void syncManager.retry(outboxId)}
        />
      ) : null}
      {canResend ? (
        <Button
          label="Send my answer again"
          size="alert"
          accessibilityLabel={`Send my answer again: ${ackStatusLabel(answer.ackStatus)}`}
          onPress={onResend}
        />
      ) : null}
      {delivery === 'disputed' && rosterAnswer && onKeepRoster ? (
        <Button
          label={`Keep ${ackStatusLabel(rosterAnswer.ackStatus)}`}
          variant="secondary"
          size="alert"
          accessibilityLabel={`Keep what the roster shows: ${ackStatusLabel(rosterAnswer.ackStatus)}`}
          onPress={onKeepRoster}
        />
      ) : null}
    </View>
  );
}
