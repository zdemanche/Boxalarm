import { spacing, typeScale } from '@boxalarm/design-tokens';
import { useNavigation } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Text, View } from 'react-native';
import { Button, useTheme } from '../../components/ui';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';
import { useScheduleRepository } from './apiScheduleRepository';
import { MarkOffNeedsConnectionError, type MarkOff } from './types';

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
  | { state: 'loaded'; markOffs: MarkOff[] };

/**
 * The member's current and upcoming mark-offs, each with an "I'm available again" (end it now)
 * action. Both need signal: the list is read live, and ending one is never queued - it changes
 * whether they are paged right now, so it either reaches the server or the member is told plainly
 * they are still marked off. Renders nothing when there are none (or no repository support).
 */
export function MarkOffList() {
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

  const refresh = useCallback(async () => {
    if (!repository.listMarkOffs) {
      setLoad({ state: 'loaded', markOffs: [] });
      return;
    }
    if (!isOnline) {
      setLoad({ state: 'offline' });
      return;
    }
    try {
      setLoad({ state: 'loaded', markOffs: await repository.listMarkOffs() });
    } catch (error) {
      setLoad(
        error instanceof MarkOffNeedsConnectionError ? { state: 'offline' } : { state: 'failed' },
      );
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
      await repository.endMarkOff(markOff.markoffId);
      const text = "You're available again. You'll be alerted for calls.";
      setMessage({ text, danger: false });
      AccessibilityInfo.announceForAccessibility(text);
      await refresh();
    } catch (error) {
      const text =
        error instanceof MarkOffNeedsConnectionError
          ? error.message
          : `Couldn't end it - you're still marked unavailable until ${formatWhen(markOff.endAt)}. Try again, or tell an officer.`;
      setMessage({ text, danger: true });
      AccessibilityInfo.announceForAccessibility(text);
    } finally {
      setEnding(null);
    }
  };

  const now = Date.now() / 1000;
  const status =
    load.state === 'offline'
      ? "You're offline, so your current mark-offs can't be shown. Ending one needs signal."
      : load.state === 'failed'
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
