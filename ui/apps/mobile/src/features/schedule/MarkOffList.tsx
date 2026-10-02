import { spacing, typeScale } from '@boxalarm/design-tokens';
import { useNavigation } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Text, View } from 'react-native';
import { Button, useTheme } from '../../components/ui';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';
import { useScheduleRepository } from './apiScheduleRepository';
import { ApiError, ApiTimeoutError } from '../../lib/apiClient';
import { MarkOffBeingSentError, MarkOffNeedsConnectionError, type MarkOff } from './types';

function formatWhen(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const day = date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}`;
}

type Load =
  | { state: 'loading' }
  | { state: 'offline' }
  | { state: 'failed' }
  | { state: 'loaded'; markOffs: MarkOff[] }
  /** The server has no mark-off list/end routes yet (404/405): the app ships on its own cadence. */
  | { state: 'unsupported' };

/** A route the deployed server does not have yet (R3-M1). */
function isUnsupported(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.problem.status === 404 || error.problem.status === 405)
  );
}

/**
 * Whether this process has seen the server's mark-off list work. Until it has, nothing about
 * ending a mark-off early is promised - not even while offline.
 */
let knownSupported = false;

/** Test seam. */
export function resetMarkOffSupportForTest(): void {
  knownSupported = false;
}

/**
 * The member's current and upcoming mark-offs, each with an "I'm available again" (end it now)
 * action. Both need signal: the list is read live, and ending one is never queued - it changes
 * whether they are paged right now, so it either reaches the server or the member is told plainly
 * they are still marked off. Renders nothing when there are none (or no repository support).
 */
export function MarkOffList({
  onSupportKnown,
}: {
  /** Told true once the list loaded (ending early works), false when the server lacks it. */
  onSupportKnown?: (supported: boolean) => void;
} = {}) {
  const theme = useTheme();
  const repository = useScheduleRepository();
  const { isOnline } = useOptionalConnectivity();
  const navigation = useNavigation();
  // Read through a ref: the navigation object need not be stable between renders.
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [ending, setEnding] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; danger: boolean } | null>(null);
  const onSupportKnownRef = useRef(onSupportKnown);
  onSupportKnownRef.current = onSupportKnown;

  const refresh = useCallback(async () => {
    const unsupported = () => {
      setLoad({ state: 'unsupported' });
      onSupportKnownRef.current?.(false);
    };
    if (!repository.listMarkOffs) {
      unsupported();
      return;
    }
    if (!isOnline) {
      setLoad({ state: 'offline' });
      return;
    }
    try {
      const markOffs = await repository.listMarkOffs();
      knownSupported = true;
      setLoad({ state: 'loaded', markOffs });
      onSupportKnownRef.current?.(true);
    } catch (error) {
      if (isUnsupported(error)) unsupported();
      else if (error instanceof MarkOffNeedsConnectionError) setLoad({ state: 'offline' });
      else setLoad({ state: 'failed' });
    }
  }, [repository, isOnline]);

  // On mount, when signal changes, and on coming back to the screen (e.g. from Mark unavailable).
  useEffect(() => {
    void refresh();
    const unsubscribe = navigationRef.current.addListener?.('focus', () => void refresh());
    return () => unsubscribe?.();
  }, [refresh]);

  const end = async (markOff: MarkOff) => {
    if (!repository.endMarkOff) return;
    setMessage(null);
    if (!isOnline) {
      const text = new MarkOffNeedsConnectionError().message;
      setMessage({ text, danger: true });
      AccessibilityInfo.announceForAccessibility(text);
      return;
    }
    setEnding(markOff.markoffId);
    try {
      await repository.endMarkOff(markOff);
      // Cancelling an upcoming mark-off never changed availability - the member was never
      // unavailable, so "available again" would be wrong (the web makes the same distinction).
      const text =
        markOff.startAt > Date.now() / 1000
          ? 'Mark-off cancelled — you stay available.'
          : "You're available again. You'll be alerted for calls.";
      setMessage({ text, danger: false });
      AccessibilityInfo.announceForAccessibility(text);
      await refresh();
    } catch (error) {
      const text =
        error instanceof MarkOffNeedsConnectionError || error instanceof MarkOffBeingSentError
          ? error.message
          : error instanceof ApiTimeoutError
            ? // The request may have reached the server before the answer was lost (minor).
              'No answer from Boxalarm - it may or may not have ended. Check again with signal before you rely on it.'
            : `Couldn't end it - you're still marked unavailable until ${formatWhen(markOff.endAt)}. Try again, or tell an officer.`;
      setMessage({ text, danger: true });
      AccessibilityInfo.announceForAccessibility(text);
    } finally {
      setEnding(null);
    }
  };

  const now = Date.now() / 1000;
  // Nothing is promised about ending early until the server has shown it can (R3-M1).
  const status =
    load.state === 'offline' && knownSupported
      ? "You're offline, so your current mark-offs can't be shown. Ending one needs signal."
      : load.state === 'failed' && knownSupported
        ? "Couldn't load your mark-offs."
        : null;
  const markOffs = load.state === 'loaded' ? load.markOffs : [];
  if (!status && markOffs.length === 0 && !message) return null;

  return (
    <View accessibilityLabel="Your mark-offs" style={{ gap: spacing.sm, marginBottom: spacing.md }}>
      {status ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={{ color: theme.status.warning, fontSize: typeScale.body.size }}>
            {status}
          </Text>
          {load.state === 'failed' ? (
            <Button label="Try again" variant="secondary" onPress={() => void refresh()} />
          ) : null}
        </View>
      ) : null}
      {markOffs.map((markOff) => {
        const active = markOff.startAt <= now;
        const when = active
          ? `Marked unavailable until ${formatWhen(markOff.endAt)}`
          : `Unavailable from ${formatWhen(markOff.startAt)} until ${formatWhen(markOff.endAt)}`;
        return (
          <View key={markOff.markoffId} style={{ gap: spacing.sm }}>
            <Text style={{ color: theme.fg, fontSize: typeScale.body.size, fontWeight: '600' }}>
              {when}
              {markOff.reason ? ` (${markOff.reason})` : ''}
            </Text>
            <Button
              label={active ? "I'm available again" : 'Cancel this mark-off'}
              variant="secondary"
              accessibilityLabel={`${active ? "I'm available again" : 'Cancel this mark-off'}. ${when}.`}
              loading={ending === markOff.markoffId}
              onPress={() => void end(markOff)}
            />
          </View>
        );
      })}
      {message ? (
        <Text
          accessibilityRole={message.danger ? 'alert' : undefined}
          style={{
            color: message.danger ? theme.status.danger : theme.fg,
            fontSize: typeScale.body.size,
            fontWeight: '600',
          }}
        >
          {message.text}
        </Text>
      ) : null}
    </View>
  );
}
