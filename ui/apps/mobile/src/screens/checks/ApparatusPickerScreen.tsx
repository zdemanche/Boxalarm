import { spacing, targetSize, typeScale } from '@boxalarm/design-tokens';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, StatusChip, useTheme } from '../../components/ui';
import { useOptionalAuth } from '../../auth/AuthContext';
import { useChecksRepository } from '../../features/checks/apiChecksRepository';
import type { Apparatus } from '../../features/checks/types';
import { ApiError } from '../../lib/apiClient';
import type { ChecksStackParamList } from '../../navigation/ChecksStack';
import { formatAsOf, NoCachedDataError } from '../../sync/readThrough';

// Cedar UpdateServiceStatus: APPARATUS_OFFICER_GROUPS.
const SERVICE_STATUS_ROLES = ['APPARATUS', 'OFFICER', 'CHIEF', 'ADMIN'] as const;

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

export function ApparatusPickerScreen() {
  const navigation = useNavigation<NavigationProp<ChecksStackParamList>>();
  const theme = useTheme();
  const repository = useChecksRepository();
  const roles = useOptionalAuth()?.roles ?? [];
  const canReturnToService = SERVICE_STATUS_ROLES.some((role) => roles.includes(role));
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

  const header = (
    <View style={{ gap: spacing.md, paddingBottom: spacing.md }}>
      <Button
        label="Field capture"
        variant="secondary"
        onPress={() => navigation.navigate('FieldCapture')}
      />
      {state.kind === 'loaded' && state.cachedAt !== null ? (
        <Text
          accessibilityRole="text"
          style={{ color: theme.status.warning, fontSize: typeScale.body.size, fontWeight: '600' }}
        >
          Offline. Showing the apparatus list saved on this phone as of {formatAsOf(state.cachedAt)}
          . Service status may have changed since.
        </Text>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      {state.kind === 'loading' ? (
        <View style={{ padding: spacing.lg, gap: spacing.md }}>
          {header}
          <View
            accessibilityRole="progressbar"
            accessibilityLabel="Loading apparatus"
            style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}
          >
            <ActivityIndicator color={theme.fg} />
            <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
              Loading apparatus…
            </Text>
          </View>
        </View>
      ) : state.kind === 'error' ? (
        <View style={{ padding: spacing.lg, gap: spacing.md }}>
          {header}
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
          >
            {state.message}
          </Text>
          <Button label="Try again" onPress={retry} />
        </View>
      ) : (
        <FlatList
          data={state.apparatus}
          keyExtractor={(item) => item.apparatusId}
          contentContainerStyle={{ padding: spacing.lg }}
          ListHeaderComponent={header}
          ListEmptyComponent={
            <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
              No apparatus is set up yet. The department administrator adds apparatus in settings.
            </Text>
          }
          renderItem={({ item }) => {
            const inService = item.status === 'IN_SERVICE';
            // Out-of-service units stay checkable (postChecks has no status gate): crews check a
            // unit before an officer returns it. The check itself doesn't change its status.
            return (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`${item.unitId}, ${item.type}, ${
                  inService ? 'in service' : 'out of service'
                }. Start check.`}
                onPress={() => navigation.navigate('CheckRunner', { apparatusId: item.unitId })}
                style={{
                  minHeight: targetSize.field,
                  justifyContent: 'center',
                  gap: spacing.xs,
                  paddingVertical: spacing.md,
                  paddingHorizontal: spacing.md,
                  borderBottomWidth: 1,
                  borderBottomColor: theme.borderDecorative,
                }}
              >
                <Text
                  style={{
                    color: theme.fg,
                    fontSize: typeScale.heading.size,
                    fontWeight: '700',
                    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                  }}
                >
                  {item.unitId}
                </Text>
                <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
                  {item.type}
                </Text>
                <StatusChip
                  status={inService ? 'ok' : 'danger'}
                  label={inService ? 'In service' : 'Out of service — you can still check it'}
                />
                {!inService && canReturnToService ? (
                  // A check doesn't change service status. The app has no service-status control
                  // yet, so point the roles Cedar allows (UpdateServiceStatus) at the web one.
                  <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
                    To return it to service, use Apparatus › {item.unitId} › Service status on the
                    Boxalarm website.
                  </Text>
                ) : null}
                <Text style={{ color: theme.fg, fontSize: typeScale.body.size, fontWeight: '600' }}>
                  Start check ›
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}
