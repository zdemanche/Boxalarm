import { spacing, typeScale } from '@boxalarm/design-tokens';
import { useCallback, useEffect, useState } from 'react';
import { AccessibilityInfo, Platform, Text, View } from 'react-native';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { Button, Card, Screen, StatusChip, useTheme } from '../../components/ui';
import {
  listRecentDispatches,
  startReportFromDispatch,
  type ReportableDispatch,
} from '../../features/incidents/recentDispatchesApi';
import { ApiError } from '../../lib/apiClient';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';
import { Notice, noticeText, ROW_PRIMARY, ROW_SECONDARY, rowDivider } from './alertsUi';

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
      const text = `Report started for ${dispatch.verifyRequired ? dispatch.incidentType : dispatch.address || dispatch.incidentType}. Finish it on the web under Incidents.`;
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

  const row = (dispatch: ReportableDispatch, index: number) => (
    <View
      key={dispatch.dispatchId}
      style={{ minHeight: 56, gap: spacing.xs, ...rowDivider(theme, index) }}
    >
      <Text style={{ color: theme.fg, ...ROW_PRIMARY }}>{dispatch.incidentType || 'Dispatch'}</Text>
      {dispatch.verifyRequired ? (
        // An unparsed CAD dispatch: the address is a placeholder, so show the text itself.
        <>
          <StatusChip status="caution" label="VERIFY — location not parsed" />
          <Text
            style={{
              color: theme.fg,
              ...ROW_SECONDARY,
              fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
            }}
          >
            “{dispatch.textExcerpt ?? ''}”
          </Text>
        </>
      ) : (
        <Text style={{ color: theme.fg, ...ROW_SECONDARY }}>
          {dispatch.address || 'No address on the dispatch'}
        </Text>
      )}
      <Text style={{ color: theme.fgMuted, fontSize: typeScale.label.size }}>
        Dispatched {when(dispatch.dispatchedAt)}
      </Text>
      {dispatch.report ? (
        <View style={{ gap: spacing.xs }}>
          <StatusChip
            status="ok"
            label={`Report started (${dispatch.report.status.toLowerCase()})`}
          />
          <Text style={{ color: theme.fgMuted, ...ROW_SECONDARY }}>Finish it on the web.</Text>
        </View>
      ) : canStart ? (
        <Button
          label="Start report"
          variant="secondary"
          accessibilityLabel={`Start report for ${dispatch.incidentType || 'dispatch'} at ${dispatch.verifyRequired ? 'an unverified location' : dispatch.address || 'unknown address'}`}
          loading={starting === dispatch.dispatchId}
          disabled={!isOnline || starting !== null}
          fullWidth
          onPress={() => void start(dispatch)}
        />
      ) : (
        <StatusChip status="neutral" label="No report yet" />
      )}
    </View>
  );

  return (
    <Screen>
      <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
        Pick a dispatch to start its report. The report is finished on the web.
      </Text>
      {!isOnline ? (
        <Notice tone="warning">
          <Text accessibilityRole="alert" style={noticeText(theme, 'warning')}>
            You&apos;re offline. Listing dispatches and starting a report need a connection.
          </Text>
        </Notice>
      ) : null}
      {message ? (
        <Notice tone="info">
          <Text accessibilityLiveRegion="polite" style={noticeText(theme, 'info')}>
            {message}
          </Text>
        </Notice>
      ) : null}
      {loadError ? (
        <Notice tone="warning">
          <Text accessibilityRole="alert" style={noticeText(theme, 'warning')}>
            {loadError}
          </Text>
          <Button label="Try again" onPress={() => void load()} />
        </Notice>
      ) : null}
      <Card title={`Last ${windowHours} hours`}>
        {loading && dispatches.length === 0 ? (
          <Text style={{ color: theme.fgMuted, ...ROW_SECONDARY }}>Loading dispatches…</Text>
        ) : recent.length === 0 && !loadError && isOnline ? (
          <Text style={{ color: theme.fgMuted, ...ROW_SECONDARY }}>
            No dispatches in the last {windowHours} hours.
          </Text>
        ) : (
          recent.map(row)
        )}
        {older.length === 0 && loadedOlder && !cursor ? (
          <Text style={{ color: theme.fgMuted, ...ROW_SECONDARY }}>No older dispatches.</Text>
        ) : null}
        {older.length === 0 && cursor && isOnline ? (
          <Button
            label="Load older dispatches"
            variant="secondary"
            loading={loading && dispatches.length > 0}
            fullWidth
            onPress={() => void load(cursor)}
          />
        ) : null}
      </Card>
      {older.length > 0 ? (
        <Card title="Older">
          {older.map(row)}
          {cursor && isOnline ? (
            <Button
              label="Load older dispatches"
              variant="secondary"
              loading={loading && dispatches.length > 0}
              fullWidth
              onPress={() => void load(cursor)}
            />
          ) : null}
        </Card>
      ) : null}
    </Screen>
  );
}
