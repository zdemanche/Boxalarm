import { radius, spacing, typeScale } from '@boxalarm/design-tokens';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { FlatList, RefreshControl, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useOptionalAuth } from '../../auth/AuthContext';
import { Button, StatusChip, useTheme } from '../../components/ui';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import { formatClock, formatElapsed } from '../../features/alerts/elapsed';
import { useActiveDispatches, type ActiveCall } from '../../features/alerts/useActiveDispatches';
import type { AlertsStackParamList } from '../../navigation/AlertsStack';

/** 72dp: the alert-path target floor (a11y-spec §1.11) - this row opens a live call. */
const CALL_ROW_MIN_HEIGHT = 72;

function CallRow({ call, onOpen }: { call: ActiveCall; onOpen: () => void }) {
  const theme = useTheme();
  const dispatchedMs = call.dispatchedAt * 1000;
  const type = call.incidentType ?? 'Dispatch';
  const address = call.address ?? 'Address not in the list - open for details';
  const tone = call.toneSequence > 1 ? ` Tone ${call.toneSequence}.` : '';
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`${type} at ${address}. Dispatched ${formatClock(dispatchedMs)}, ${formatElapsed(dispatchedMs)}.${tone}${call.fromPageOnly ? ' Received on this phone; not confirmed by the server.' : ''} Open call.`}
      onPress={onOpen}
      style={{
        minHeight: CALL_ROW_MIN_HEIGHT,
        padding: spacing.md,
        marginBottom: spacing.sm,
        borderRadius: radius.card,
        borderWidth: 2,
        borderColor: theme.status.danger,
        backgroundColor: theme.surface,
        gap: 4,
      }}
    >
      <Text
        style={{ color: theme.status.warning, fontSize: typeScale.heading.size, fontWeight: '700' }}
      >
        {type.toUpperCase()}
        {call.toneSequence > 1 ? ` · TONE ${call.toneSequence}` : ''}
      </Text>
      <Text style={{ color: theme.fg, fontSize: typeScale.display.size, fontWeight: '700' }}>
        {address}
      </Text>
      {call.crossStreets ? (
        <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
          x {call.crossStreets}
        </Text>
      ) : null}
      <Text
        style={{ color: theme.fgMuted, fontSize: typeScale.mono.size, fontFamily: 'monospace' }}
      >
        {formatClock(dispatchedMs)} · {formatElapsed(dispatchedMs)}
      </Text>
      {call.fromPageOnly ? (
        <StatusChip status="warning" label="Received on this phone - not confirmed" />
      ) : null}
    </TouchableOpacity>
  );
}

// E1-S1-UI kept: officer-only degraded-mode manual entry (N1.8). The screen is now the in-app
// path to an active call (alert-ux C3): a swiped-away or cleared notification no longer takes
// the call with it.
export function AlertsHomeScreen() {
  const navigation = useNavigation<NavigationProp<AlertsStackParamList>>();
  const theme = useTheme();
  const auth = useOptionalAuth();
  const repository = useAlertsRepository();
  const active = useActiveDispatches(repository);
  const canEnterManually = (auth?.roles ?? []).some(
    (role) => role === 'OFFICER' || role === 'CHIEF',
  );

  const asOf = active.updatedAt ? formatClock(active.updatedAt) : null;
  const unreachable = active.failure !== null;

  const header = (
    <View style={{ gap: spacing.sm, marginBottom: spacing.md }}>
      <Text
        accessibilityRole="header"
        style={{ color: theme.fg, fontSize: typeScale.title.size, fontWeight: '700' }}
      >
        Alerts
      </Text>
      {unreachable ? (
        <View
          accessibilityLiveRegion="polite"
          style={{
            padding: spacing.md,
            borderRadius: radius.default,
            borderLeftWidth: 4,
            borderLeftColor: theme.status.warning,
            backgroundColor: theme.surface,
          }}
        >
          <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
            {active.source === 'cached' && asOf
              ? `▲ Can't reach Boxalarm. Showing active calls saved on this phone at ${asOf} - they may have changed.`
              : "▲ Can't reach Boxalarm, and no call list is saved on this phone yet."}
          </Text>
        </View>
      ) : asOf ? (
        <Text style={{ color: theme.fgMuted, fontSize: typeScale.caption.size }}>
          Updated {asOf}
        </Text>
      ) : null}
      {active.truncated ? (
        <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
          Showing the most recent active calls only.
        </Text>
      ) : null}
    </View>
  );

  const empty = active.loading ? (
    <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
      Loading active calls…
    </Text>
  ) : unreachable ? null : (
    <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
      No active calls. Calls appear here as soon as you're paged, even if you dismiss the
      notification.
    </Text>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <FlatList
        data={active.calls}
        keyExtractor={(call) => call.dispatchId}
        contentContainerStyle={{ padding: spacing.lg, flexGrow: 1 }}
        ListHeaderComponent={header}
        ListEmptyComponent={empty ?? undefined}
        refreshControl={
          <RefreshControl
            refreshing={active.refreshing}
            onRefresh={() => void active.refresh()}
            accessibilityLabel="Pull to refresh active calls"
          />
        }
        renderItem={({ item }) => (
          <CallRow
            call={item}
            onOpen={() =>
              navigation.navigate('AlertDetail', {
                dispatchId: item.dispatchId,
                payload: {
                  dispatchId: item.dispatchId,
                  incidentType: item.incidentType ?? 'Dispatch',
                  address: item.address ?? '',
                  ...(item.crossStreets ? { crossStreets: item.crossStreets } : {}),
                  toneSequence: item.toneSequence,
                  receivedAt: item.dispatchedAt * 1000,
                },
              })
            }
          />
        )}
        ListFooterComponent={
          <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
            {/* Pull-to-refresh is an accelerator only (a11y-spec N3): a real button too. */}
            <Button
              label={active.refreshing ? 'Refreshing…' : 'Refresh'}
              variant="secondary"
              accessibilityLabel="Refresh active calls"
              loading={active.refreshing}
              onPress={() => void active.refresh()}
            />
            {canEnterManually ? (
              <Button
                label="Enter dispatch manually"
                onPress={() => navigation.navigate('ManualEntry')}
              />
            ) : null}
          </View>
        }
      />
    </SafeAreaView>
  );
}
