import { radiusScale, spacing, targetSize, typeScale } from '@boxalarm/design-tokens';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { Button, Card, Screen, StatusChip, useTheme } from '../../components/ui';
import { useOptionalAuth } from '../../auth/AuthContext';
import { useChecksRepository } from '../../features/checks/apiChecksRepository';
import type { Apparatus } from '../../features/checks/types';
import { ApiError } from '../../lib/apiClient';
import { SERVICE_STATUS_ROLES } from '../../features/checks/serviceStatusApi';
import type { ChecksStackParamList } from '../../navigation/ChecksStack';
import { formatAsOf, NoCachedDataError } from '../../sync/readThrough';
import { ROW_TEXT_SIZE } from './fieldText';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; apparatus: Apparatus[]; cachedAt: number | null }
  | { kind: 'error'; message: string };

function describeLoadError(error: unknown): string {
  if (error instanceof NoCachedDataError) {
    return "You're offline, and this phone hasn't loaded the apparatus list yet. Connect once to download it; after that, checks work without signal.";
  }
  if (error instanceof ApiError && error.problem.status === 403) {
    return 'You do not have access to apparatus. Sign out and back in, or contact your department administrator.';
  }
  if (error instanceof ApiError) {
    return 'Boxalarm could not load the apparatus list. Try again.';
  }
  return 'Apparatus could not be loaded. Check your connection and try again.';
}

/** `ENGINE` / `BRUSH_TRUCK` as a reader says it: "Engine" / "Brush truck". */
function typeLabel(type: string): string {
  const words = type.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function ApparatusPickerScreen() {
  const navigation = useNavigation<NavigationProp<ChecksStackParamList>>();
  const theme = useTheme();
  const repository = useChecksRepository();
  const roles = useOptionalAuth()?.roles ?? [];
  const canChangeServiceStatus = SERVICE_STATUS_ROLES.some((role) => roles.includes(role));
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // `repository` is memoized (see useChecksRepository) so this only re-fires when auth state
  // or the API base URL actually changes, not on every render.
  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    repository
      .getApparatus()
      .then((apparatus) => {
        if (cancelled) return;
        setState({
          kind: 'loaded',
          apparatus,
          cachedAt: repository.apparatusCachedAt?.() ?? null,
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: describeLoadError(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [repository, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // Coming back from the service-status screen: reload, so the row shows the new status. The
  // first focus is the initial mount, which the load effect above already covers (review minor 7).
  const seenFirstFocus = useRef(false);
  useEffect(
    () =>
      navigation.addListener?.('focus', () => {
        if (!seenFirstFocus.current) {
          seenFirstFocus.current = true;
          return;
        }
        setAttempt((n) => n + 1);
      }),
    [navigation],
  );

  const fieldCapture = (
    <Card>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Field capture"
        accessibilityHint="Record an inspection, its violations and a photo."
        onPress={() => navigation.navigate('FieldCapture')}
        style={{
          minHeight: targetSize.field,
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.md,
        }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: theme.fg, fontSize: ROW_TEXT_SIZE, fontWeight: '600' }}>
            Field capture
          </Text>
          <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
            An inspection, its violations and a photo. Saved on this phone first.
          </Text>
        </View>
        <Text accessible={false} style={{ color: theme.fgFaint, fontSize: typeScale.title.size }}>
          ›
        </Text>
      </TouchableOpacity>
    </Card>
  );

  return (
    <Screen>
      {state.kind === 'loading' ? (
        <Card>
          <View
            accessibilityRole="progressbar"
            accessibilityLabel="Loading apparatus"
            style={{
              minHeight: targetSize.field,
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.sm,
            }}
          >
            <ActivityIndicator color={theme.fg} />
            <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
              Loading apparatus…
            </Text>
          </View>
        </Card>
      ) : state.kind === 'error' ? (
        <Card>
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
          >
            {state.message}
          </Text>
          <Button label="Try again" onPress={retry} />
        </Card>
      ) : (
        <>
          {state.cachedAt !== null ? (
            <Card>
              <Text
                accessibilityRole="text"
                style={{
                  color: theme.status.warning,
                  fontSize: typeScale.body.size,
                  fontWeight: '600',
                }}
              >
                Offline. Showing the apparatus list saved on this phone as of{' '}
                {formatAsOf(state.cachedAt)}. Service status may have changed since.
              </Text>
            </Card>
          ) : null}
          {state.apparatus.length === 0 ? (
            <Card>
              <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
                No apparatus is set up yet. The department administrator adds apparatus in settings.
              </Text>
            </Card>
          ) : null}
          {state.apparatus.map((item) => {
            const inService = item.status === 'IN_SERVICE';
            // Out-of-service units stay checkable (postChecks has no status gate): crews check a
            // unit before an officer returns it. The check itself doesn't change its status.
            return (
              <Card key={item.apparatusId}>
                {/* The whole top of the card - name, status and the amber bar - is one
                    glove-sized target for the check, the main job on this tab. */}
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`${item.unitId}, ${item.type}, ${
                    inService ? 'in service' : 'out of service'
                  }. Start check.`}
                  onPress={() => navigation.navigate('CheckRunner', { apparatusId: item.unitId })}
                  style={{ gap: spacing.md }}
                >
                  <View
                    style={{
                      flexDirection: 'row',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: spacing.sm,
                    }}
                  >
                    <View style={{ flexShrink: 1, gap: 2 }}>
                      <Text
                        style={{
                          color: theme.fg,
                          fontSize: typeScale.title.size,
                          fontWeight: '700',
                        }}
                      >
                        {item.unitId}
                      </Text>
                      <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
                        {typeLabel(item.type)}
                      </Text>
                    </View>
                    <StatusChip
                      status={inService ? 'ok' : 'danger'}
                      label={inService ? 'In service' : 'Out of service — you can still check it'}
                    />
                  </View>
                  <View
                    style={{
                      minHeight: targetSize.field,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: spacing.sm,
                      borderRadius: radiusScale.lg,
                      backgroundColor: theme.accentFill,
                    }}
                  >
                    <Text
                      style={{
                        color: theme.onAccentFill,
                        fontSize: ROW_TEXT_SIZE,
                        fontWeight: '700',
                      }}
                    >
                      Start check
                    </Text>
                    <Text
                      accessible={false}
                      style={{
                        color: theme.onAccentFill,
                        fontSize: ROW_TEXT_SIZE,
                        fontWeight: '700',
                      }}
                    >
                      ›
                    </Text>
                  </View>
                </TouchableOpacity>
                {canChangeServiceStatus ? (
                  // A check doesn't change service status; this does (Cedar UpdateServiceStatus).
                  <Button
                    label={inService ? 'Take out of service' : 'Return to service'}
                    variant="secondary"
                    accessibilityLabel={
                      inService
                        ? `Take ${item.unitId} out of service`
                        : `Return ${item.unitId} to service`
                    }
                    onPress={() =>
                      navigation.navigate('ServiceStatus', {
                        unitId: item.unitId,
                        status: item.status,
                      })
                    }
                  />
                ) : null}
              </Card>
            );
          })}
        </>
      )}
      {fieldCapture}
    </Screen>
  );
}
