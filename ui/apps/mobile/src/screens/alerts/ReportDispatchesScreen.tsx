import { radius, spacing, typeScale } from '@boxalarm/design-tokens';
import { useCallback, useEffect, useState } from 'react';
import { AccessibilityInfo, ScrollView, Text, View } from 'react-native';
import Config from 'react-native-config';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useOptionalAuth } from '../../auth/AuthContext';
import { Button, useTheme } from '../../components/ui';
import {
  listRecentDispatches,
  startReportFromDispatch,
  type ReportableDispatch,
} from '../../features/incidents/recentDispatchesApi';
import { ApiError } from '../../lib/apiClient';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';

// Listing dispatches and starting a report are both the NERIS officer tier (Cedar
// ListRecentDispatches, CreateIncidentReport): OFFICER, CHIEF, ADMIN.
const CAN_START: readonly string[] = ['OFFICER', 'CHIEF', 'ADMIN'];

function when(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function problemText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.problem.status === 403) return 'Your role cannot do this. Ask the chief.';
    return error.problem.detail ?? error.problem.title;
  }
  return fallback;
}

/**
 * "Start a report" on the phone: the department's dispatches of the last 72 hours (then older on
 * request), each with its report status. Starting one creates the draft pre-filled from the
 * dispatch; the report itself is finished on the web (design.md F-17: "the report continues on
 * the web"). Needs a connection - nothing here is queued.
 */
export function ReportDispatchesScreen() {
  const theme = useTheme();
  const auth = useOptionalAuth();
  const { isOnline } = useOptionalConnectivity();
  const apiBaseUrl = Config.API_BASE_URL ?? '';
  const canStart = (auth?.roles ?? []).some((role) => CAN_START.includes(role));

  const [dispatches, setDispatches] = useState<ReportableDispatch[]>([]);
  const [windowHours, setWindowHours] = useState(72);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadedOlder, setLoadedOlder] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(
    async (next?: string) => {
      if (!auth || !apiBaseUrl) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setLoadError(null);
      try {
        const page = await listRecentDispatches(auth, apiBaseUrl, next);
        setWindowHours(page.recentWindowHours);
        setDispatches((current) => (next ? [...current, ...page.dispatches] : page.dispatches));
        setCursor(page.nextCursor);
        if (next) setLoadedOlder(true);
      } catch (error) {
        setLoadError(problemText(error, "Can't reach Boxalarm. Try again when you have signal."));
      } finally {
        setLoading(false);
      }
    },
    [auth, apiBaseUrl],
  );

  useEffect(() => {
    if (isOnline) void load();
    else setLoading(false);
  }, [isOnline, load]);

  const start = async (dispatch: ReportableDispatch) => {
    if (!auth || !isOnline) return;
    setStarting(dispatch.dispatchId);
    setMessage(null);
    try {
      const created = await startReportFromDispatch(auth, apiBaseUrl, dispatch.dispatchId);
      setDispatches((current) =>
        current.map((d) =>
          d.dispatchId === dispatch.dispatchId
            ? { ...d, report: { incidentId: created.incidentId, status: 'DRAFT' } }
            : d,
        ),
      );
      const text = `Report started for ${dispatch.address || dispatch.incidentType}. Finish it on the web under Incidents.`;
      setMessage(text);
      AccessibilityInfo.announceForAccessibility(text);
    } catch (error) {
      const text = problemText(error, 'The report was not started. Try again.');
      setMessage(text);
      AccessibilityInfo.announceForAccessibility(text);
    } finally {
      setStarting(null);
    }
  };

  const windowStart = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const recent = dispatches.filter((d) => d.dispatchedAt >= windowStart);
  const older = dispatches.filter((d) => d.dispatchedAt < windowStart);

  const row = (dispatch: ReportableDispatch) => (
    <View
      key={dispatch.dispatchId}
      style={{
        gap: spacing.xs,
        padding: spacing.md,
        borderRadius: radius.default,
        backgroundColor: theme.surface,
      }}
    >
      <Text style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '700' }}>
        {dispatch.incidentType || 'Dispatch'}
      </Text>
      <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
        {dispatch.address || 'No address on the dispatch'}
      </Text>
      <Text style={{ color: theme.fgMuted, fontSize: typeScale.caption.size }}>
        Dispatched {when(dispatch.dispatchedAt)}
      </Text>
      {dispatch.report ? (
        <Text style={{ color: theme.status.ok, fontSize: typeScale.body.size }}>
          ✓ Report started ({dispatch.report.status.toLowerCase()}) — finish it on the web
        </Text>
      ) : canStart ? (
        <Button
          label="Start report"
          accessibilityLabel={`Start report for ${dispatch.incidentType || 'dispatch'} at ${dispatch.address || 'unknown address'}`}
          loading={starting === dispatch.dispatchId}
          disabled={!isOnline || starting !== null}
          onPress={() => void start(dispatch)}
        />
      ) : (
        <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>No report yet</Text>
      )}
    </View>
  );

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: theme.bg }}
      edges={['bottom', 'left', 'right']}
    >
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
        <Text
          accessibilityRole="header"
          style={{ color: theme.fg, fontSize: typeScale.title.size, fontWeight: '700' }}
        >
          Start a report
        </Text>
        {!isOnline ? (
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.warning, fontSize: typeScale.body.size }}
          >
            You&apos;re offline. Listing dispatches and starting a report need a connection.
          </Text>
        ) : null}
        {message ? (
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: theme.fg, fontSize: typeScale.body.size }}
          >
            {message}
          </Text>
        ) : null}
        {loadError ? (
          <View style={{ gap: spacing.sm }}>
            <Text
              accessibilityRole="alert"
              style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
            >
              {loadError}
            </Text>
            <Button label="Try again" onPress={() => void load()} />
          </View>
        ) : null}
        <Text
          accessibilityRole="header"
          style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '600' }}
        >
          Last {windowHours} hours
        </Text>
        {loading && dispatches.length === 0 ? (
          <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
            Loading dispatches…
          </Text>
        ) : recent.length === 0 && !loadError && isOnline ? (
          <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
            No dispatches in the last {windowHours} hours.
          </Text>
        ) : (
          recent.map(row)
        )}
        {older.length > 0 ? (
          <>
            <Text
              accessibilityRole="header"
              style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '600' }}
            >
              Older
            </Text>
            {older.map(row)}
          </>
        ) : loadedOlder && !cursor ? (
          <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
            No older dispatches.
          </Text>
        ) : null}
        {cursor && isOnline ? (
          <Button
            label="Load older dispatches"
            variant="secondary"
            loading={loading && dispatches.length > 0}
            onPress={() => void load(cursor)}
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
