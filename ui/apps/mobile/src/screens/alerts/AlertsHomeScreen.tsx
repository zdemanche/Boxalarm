import { spacing, typeScale } from '@boxalarm/design-tokens';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { Platform, RefreshControl, Text, TouchableOpacity, View } from 'react-native';
import { useOptionalAuth } from '../../auth/AuthContext';
import { Button, Card, StatusChip, useTheme } from '../../components/ui';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import { formatClock, formatElapsed } from '../../features/alerts/elapsed';
import { useActiveDispatches, type ActiveCall } from '../../features/alerts/useActiveDispatches';
import type { DetailFailure } from '../../features/alerts/useAlertDetail';
import type { AlertsStackParamList } from '../../navigation/AlertsStack';
import {
  CanvasScrollView,
  Chevron,
  LiveCard,
  LiveDot,
  Notice,
  noticeText,
  ROW_SECONDARY,
  rowDivider,
} from './alertsUi';

// Review m7: "can't reach" and "refused" need different words - a refusal will not fix itself
// by moving to signal.
function failureLead(failure: DetailFailure | null): string {
  switch (failure) {
    case 'refused':
      return 'Boxalarm refused the call list for this sign-in - tell your officer.';
    case 'server':
      return "Boxalarm's server had a problem loading the call list.";
    default:
      return "Can't reach Boxalarm.";
  }
}

/** 72dp: the alert-path target floor (a11y-spec §1.11) - this row opens a live call. */
const CALL_ROW_MIN_HEIGHT = 72;

function CallRow({ call, index, onOpen }: { call: ActiveCall; index: number; onOpen: () => void }) {
  const theme = useTheme();
  const dispatchedMs = call.dispatchedAt * 1000;
  const type = call.incidentType ?? 'Dispatch';
  const address = call.address ?? 'Address not in the list - open for details';
  const tone = call.toneSequence > 1 ? ` Tone ${call.toneSequence}.` : '';
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`${type} at ${address}. ${call.fromPageOnly ? 'Received' : 'Dispatched'} ${formatClock(dispatchedMs)}, ${formatElapsed(dispatchedMs)}.${tone}${call.fromPageOnly ? ' Received on this phone; not confirmed by the server.' : ''} Open call.`}
      onPress={onOpen}
      style={{
        minHeight: CALL_ROW_MIN_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingVertical: spacing.sm,
        ...rowDivider(theme, index),
      }}
    >
      <View style={{ flex: 1, gap: 4 }}>
        <Text
          style={{
            color: theme.status.danger,
            fontSize: typeScale.subheading.size,
            fontWeight: '800',
            letterSpacing: 0.5,
          }}
        >
          {type.toUpperCase()}
          {call.toneSequence > 1 ? ` · TONE ${call.toneSequence}` : ''}
        </Text>
        <Text
          style={{
            color: theme.fg,
            fontSize: typeScale.title.size,
            lineHeight: typeScale.title.lineHeight,
            fontWeight: '800',
          }}
        >
          {address}
        </Text>
        {call.crossStreets ? (
          <Text style={{ color: theme.fg, ...ROW_SECONDARY }}>x {call.crossStreets}</Text>
        ) : null}
        <Text
          style={{
            color: theme.fgMuted,
            fontSize: typeScale.mono.size,
            fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
          }}
        >
          {call.fromPageOnly ? 'received' : 'dispatched'} {formatClock(dispatchedMs)} ·{' '}
          {formatElapsed(dispatchedMs)}
        </Text>
        {call.fromPageOnly ? (
          <StatusChip
            status="warning"
            label="Received on this phone - not in the server list yet"
          />
        ) : null}
      </View>
      <Chevron />
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
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const unsubscribeFocus = navigation.addListener?.('focus', () => setVisible(true));
    const unsubscribeBlur = navigation.addListener?.('blur', () => setVisible(false));
    return () => {
      unsubscribeFocus?.();
      unsubscribeBlur?.();
    };
  }, [navigation]);
  const active = useActiveDispatches(repository, visible);
  const canEnterManually = (auth?.roles ?? []).some(
    (role) => role === 'OFFICER' || role === 'CHIEF',
  );
  // Cedar ListRecentDispatches (NERIS officer tier).
  const canReport = (auth?.roles ?? []).some(
    (role) => role === 'OFFICER' || role === 'CHIEF' || role === 'ADMIN',
  );

  const asOf = active.updatedAt ? formatClock(active.updatedAt) : null;
  const unreachable = active.failure !== null;

  const status = unreachable ? (
    <Notice tone="warning" accessibilityLiveRegion="polite">
      <Text style={noticeText(theme, 'warning')}>
        {active.source === 'cached' && asOf
          ? `${failureLead(active.failure)} Showing active calls saved on this phone at ${asOf} - they may have changed.`
          : `${failureLead(active.failure)} No call list is saved on this phone yet.`}
      </Text>
    </Notice>
  ) : asOf ? (
    <Text style={{ color: theme.fgMuted, fontSize: typeScale.caption.size }}>Updated {asOf}</Text>
  ) : null;

  const empty = active.loading ? (
    <Text style={{ color: theme.fgMuted, ...ROW_SECONDARY }}>Loading active calls…</Text>
  ) : unreachable ? null : (
    <Text style={{ color: theme.fgMuted, ...ROW_SECONDARY }}>
      No active calls. Calls appear here as soon as you're paged, even if you dismiss the
      notification.
    </Text>
  );

  const open = (item: ActiveCall) =>
    navigation.navigate('AlertDetail', {
      dispatchId: item.dispatchId,
      payload: {
        dispatchId: item.dispatchId,
        incidentType: item.incidentType ?? 'Dispatch',
        address: item.address ?? '',
        ...(item.crossStreets ? { crossStreets: item.crossStreets } : {}),
        toneSequence: item.toneSequence,
        // A server row's time is the dispatch time; a page-only row's is receipt.
        ...(item.fromPageOnly ? {} : { dispatchedAt: item.dispatchedAt * 1000 }),
        receivedAt: item.dispatchedAt * 1000,
      },
    });

  const live = active.calls.length > 0;

  return (
    <CanvasScrollView
      refreshControl={
        <RefreshControl
          refreshing={active.refreshing}
          onRefresh={() => void active.refresh()}
          accessibilityLabel="Pull to refresh active calls"
        />
      }
    >
      {/* Active calls first: a live card (alarm edge) while there is a call to go to. */}
      <LiveCard live={live}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          {live ? <LiveDot /> : null}
          <Text
            accessibilityRole="header"
            style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '700' }}
          >
            Active calls
          </Text>
        </View>
        {status}
        {live
          ? active.calls.map((call, index) => (
              <CallRow key={call.dispatchId} call={call} index={index} onOpen={() => open(call)} />
            ))
          : empty}
        {active.truncated ? (
          <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
            Showing the most recent active calls only.
          </Text>
        ) : null}
        {/* Pull-to-refresh is an accelerator only (a11y-spec N3): a real button too. */}
        <Button
          label={active.refreshing ? 'Refreshing…' : 'Refresh'}
          variant="secondary"
          accessibilityLabel="Refresh active calls"
          loading={active.refreshing}
          fullWidth
          onPress={() => void active.refresh()}
        />
      </LiveCard>

      {canEnterManually || canReport ? (
        <Card title="Officer actions">
          {canEnterManually ? (
            <Button
              label="Enter dispatch manually"
              fullWidth
              onPress={() => navigation.navigate('ManualEntry')}
            />
          ) : null}
          {canReport ? (
            <Button
              label="Start a report"
              variant="secondary"
              fullWidth
              onPress={() => navigation.navigate('ReportDispatches')}
            />
          ) : null}
        </Card>
      ) : null}
    </CanvasScrollView>
  );
}
