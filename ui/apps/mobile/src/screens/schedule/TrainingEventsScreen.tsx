import { spacing, targetSize, typeScale } from '@boxalarm/design-tokens';
import { useEffect, useRef, useState } from 'react';
import Config from 'react-native-config';
import { Text, TouchableOpacity, View } from 'react-native';
import { useOptionalAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { Card, Screen, StatusChip, useTheme } from '../../components/ui';
import { getTrainingEvents, signUpForEvent } from '../../features/training/api';
import type { TrainingEvent } from '../../features/training/types';

/** Field rows: primary text 17/600 (docs/design.md §1 field body). */
const ROW_TITLE_SIZE = 17;

function formatEventTime(startAt: number): string {
  return new Date(startAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function TrainingEventsScreen() {
  const theme = useTheme();
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const [events, setEvents] = useState<TrainingEvent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signUpError, setSignUpError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (!auth?.isAuthenticated || !apiBaseUrl) return;
    setLoadError(null);
    getTrainingEvents(auth, apiBaseUrl)
      .then((result) => {
        if (!cancelled) setEvents(result);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError('Training events could not be loaded. Check your connection and try again.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [auth, apiBaseUrl]);

  const onSignUp = async (eventId: string) => {
    if (!auth || !apiBaseUrl || inFlight.current) return;
    const markSignedUp = () =>
      setEvents((prev) => prev.map((e) => (e.eventId === eventId ? { ...e, signedUp: true } : e)));
    setSignUpError(null);
    inFlight.current = true;
    setPendingId(eventId);
    try {
      await signUpForEvent(auth, apiBaseUrl, eventId);
      markSignedUp();
    } catch (error) {
      const status = error instanceof ApiError ? error.problem.status : undefined;
      if (status === 409) {
        markSignedUp();
      } else {
        setSignUpError(
          status === 422
            ? 'Sign-up is closed: this event has started.'
            : 'Could not sign you up. Check your connection and try again.',
        );
      }
    } finally {
      inFlight.current = false;
      setPendingId(null);
    }
  };

  return (
    <Screen>
      {loadError ? (
        <Card>
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
          >
            {loadError}
          </Text>
        </Card>
      ) : null}
      {signUpError ? (
        <Card>
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
          >
            {signUpError}
          </Text>
        </Card>
      ) : null}
      <Card>
        {events.length === 0 ? (
          <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
            No training events scheduled.
          </Text>
        ) : (
          <View>
            {events.map((item, index) => {
              const started = item.startAt <= Date.now();
              return (
                <TouchableOpacity
                  key={item.eventId}
                  accessibilityRole="button"
                  disabled={item.signedUp || started || pendingId !== null}
                  onPress={() => void onSignUp(item.eventId)}
                  style={{
                    minHeight: targetSize.field,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.md,
                    paddingVertical: spacing.sm + spacing.xs,
                    borderTopWidth: index === 0 ? 0 : 1,
                    borderTopColor: theme.borderDecorative,
                  }}
                >
                  <View style={{ flex: 1, gap: spacing.xs }}>
                    <Text style={{ color: theme.fg, fontSize: ROW_TITLE_SIZE, fontWeight: '600' }}>
                      {item.title}
                    </Text>
                    <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
                      {formatEventTime(item.startAt)} · {item.category}
                    </Text>
                  </View>
                  {item.signedUp ? (
                    <StatusChip status="ok" label="Signed up" />
                  ) : started ? (
                    <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
                      Sign-up closed
                    </Text>
                  ) : (
                    <Text
                      style={{
                        color: theme.accent,
                        fontSize: typeScale.body.size,
                        fontWeight: '700',
                      }}
                    >
                      Sign up
                    </Text>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </Card>
    </Screen>
  );
}
