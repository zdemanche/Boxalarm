import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, PageHeader, Skeleton, StatusChip, TextInput } from '../../components/ui';
import { listMembers } from '../../features/personnel/api';
import { getCanaryStatus, getDiagnostics, listActiveDispatches } from './api';
import type { StatusRole } from '@boxalarm/design-tokens';
import type { DeviceState, DiagnosticsTimelineEntry } from './types';
import styles from './Alerts.module.css';

// AC2 intent ("never a stale green"): canary/statusHandler.ts computes healthy purely from
// latestResult, with no staleness check. OQ-8 leaves the real cadence unresolved (proposed
// every 1-2 min); this is a stated default (2x a 120s assumed interval), not an architecture
// fact - see the plan's Risks section.
const CANARY_STALE_AFTER_MS = 240_000;

function timelineLabel(entry: DiagnosticsTimelineEntry): string {
  if (entry.entityType === 'DELIVERY_RECEIPT') {
    // The diagnostics route returns raw DELIVERY_RECEIPT items, which have no status field:
    // the provider callbacks set failureReason / deliveredAt / openedAt
    // (receipts/deliveryReceiptRepository.ts). Keying on `status` alone labelled every
    // delivered page "Sent, not confirmed delivered".
    if (entry.openedAt || entry.status === 'OPENED') return 'Opened';
    if (entry.deliveredAt || entry.status === 'DELIVERED') return 'Delivered';
    if (entry.failureReason || entry.status === 'FAILED') {
      return `Failed${entry.failureReason ? ` — ${entry.failureReason}` : ''}`;
    }
    return 'Sent, not confirmed delivered';
  }
  if (entry.entityType === 'ESCALATION_EVENT')
    return `Escalated${entry.reason ? ` — ${entry.reason}` : ''}`;
  if (entry.entityType === 'DISPATCH_RESPONSE_RECORD')
    return `Response logged — ${entry.ackStatus ?? ''}`;
  return entry.entityType;
}

/** A delivery event carries its status as colour + glyph + word; other events are plain text. */
function timelineRole(entry: DiagnosticsTimelineEntry): StatusRole | null {
  if (entry.entityType !== 'DELIVERY_RECEIPT') return null;
  if (entry.openedAt || entry.status === 'OPENED') return 'ok';
  if (entry.deliveredAt || entry.status === 'DELIVERED') return 'ok';
  if (entry.failureReason || entry.status === 'FAILED') return 'danger';
  return 'warning';
}

function timelineTime(entry: DiagnosticsTimelineEntry): number | undefined {
  return entry.sentAt ?? entry.escalatedAt ?? entry.answeredAt;
}

function DeviceCheckPanel({ deviceState }: { deviceState: DeviceState | null }) {
  if (!deviceState) {
    return (
      <Card title="Device check">
        <p className={styles.muted}>No device report on file.</p>
      </Card>
    );
  }
  const checks: { label: string; ok: boolean }[] = [
    { label: 'Notification permission', ok: deviceState.notificationPermission },
    {
      label: 'Critical-alert / full-screen-intent permission',
      ok: deviceState.criticalAlertPermission,
    },
    { label: 'Battery-optimization exemption', ok: deviceState.batteryOptimizationExempt },
  ];
  return (
    <Card title="Device check">
      <ul className={styles.checkList}>
        {checks.map((check) => (
          <li key={check.label}>
            <StatusChip status={check.ok ? 'ok' : 'danger'} className={styles.wrapChip}>
              {check.label}: {check.ok ? 'OK' : 'Not granted'}
            </StatusChip>
          </li>
        ))}
        <li>
          App {deviceState.appVersion} on {deviceState.osVersion}
        </li>
      </ul>
      <p className={styles.lookupHelp}>
        Reported {new Date(deviceState.reportedAt * 1000).toLocaleString()}
      </p>
    </Card>
  );
}

function TimelineTable({ dispatchId, memberId }: { dispatchId: string; memberId: string }) {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['alerts', 'diagnostics', dispatchId, memberId],
    queryFn: () => getDiagnostics(auth, dispatchId, memberId),
  });

  if (query.error) {
    return (
      <ApiForbiddenGate error={query.error} embedded>
        <p>Diagnostics are unavailable.</p>
      </ApiForbiddenGate>
    );
  }
  if (query.isLoading || !query.data) {
    return (
      <Card title="Delivery timeline">
        <Skeleton lines={4} />
      </Card>
    );
  }

  const { diagnosis, timeline, deviceState } = query.data;

  if (diagnosis === 'NOT_ON_ELIGIBLE_ROSTER') {
    return (
      <Card title="Diagnosis">
        <StatusChip status="danger">Not on the eligible roster</StatusChip>
        <p className={styles.diagnosis}>
          This member had no delivery record for this dispatch because they were not on the eligible
          roster — this is distinct from a page that was sent but not delivered.
        </p>
      </Card>
    );
  }

  return (
    <>
      <Card title="Delivery timeline">
        {timeline.length === 0 ? (
          <p className={styles.muted}>Sent, not yet delivered — no timeline entries recorded.</p>
        ) : (
          <div
            role="region"
            aria-label="Delivery timeline"
            tabIndex={0}
            className={styles.tableWrap}
          >
            <table className={styles.table}>
              <caption className="visually-hidden">Delivery timeline</caption>
              <thead>
                <tr>
                  <th scope="col">Channel</th>
                  <th scope="col">Tone</th>
                  <th scope="col">Event</th>
                  <th scope="col">Time</th>
                </tr>
              </thead>
              <tbody>
                {timeline.map((entry, index) => {
                  const time = timelineTime(entry);
                  const role = timelineRole(entry);
                  return (
                    <tr key={`${entry.entityType}-${index}`}>
                      <th scope="row">{entry.channel?.toUpperCase() ?? '—'}</th>
                      <td>{entry.toneSequence ?? '—'}</td>
                      <td>
                        {role ? (
                          <StatusChip status={role}>{timelineLabel(entry)}</StatusChip>
                        ) : (
                          timelineLabel(entry)
                        )}
                      </td>
                      <td className={styles.timeCell}>
                        {time ? new Date(time * 1000).toLocaleString() : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <DeviceCheckPanel deviceState={deviceState} />
    </>
  );
}

function CanaryPanel() {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['alerts', 'canary', 'status'],
    queryFn: () => getCanaryStatus(auth),
  });

  if (query.error) {
    return (
      <ApiForbiddenGate error={query.error} embedded>
        <p>Canary status is unavailable.</p>
      </ApiForbiddenGate>
    );
  }
  if (query.isLoading || !query.data) {
    return (
      <Card title="Canary health">
        <Skeleton lines={3} />
      </Card>
    );
  }

  const { healthy, latestResult, latestLatencyMs, latestRanAt } = query.data;
  const stale = latestRanAt === null || Date.now() - latestRanAt * 1000 > CANARY_STALE_AFTER_MS;
  const isHealthy = healthy && !stale;
  const overBudget = latestLatencyMs !== null && latestLatencyMs > 5000;

  return (
    <Card title="Canary health">
      <StatusChip status={isHealthy ? 'ok' : 'danger'}>
        {isHealthy ? 'Healthy' : stale ? 'Unhealthy — last run is stale' : 'Unhealthy'}
      </StatusChip>
      <dl className={styles.facts}>
        <dt>Last run</dt>
        <dd>{latestRanAt ? new Date(latestRanAt * 1000).toLocaleString() : 'No runs recorded'}</dd>
        <dt>Result</dt>
        <dd>{latestResult ?? '—'}</dd>
        <dt>Latency vs 5s budget</dt>
        <dd>
          {latestLatencyMs !== null ? `${latestLatencyMs}ms` : '—'}
          {overBudget ? ' (over budget)' : ''}
        </dd>
      </dl>
      {query.data.runs[0] ? (
        <ul className={styles.chipRow} aria-label="Latest run by channel">
          {Object.entries(query.data.runs[0].channelResults).map(([channel, result]) => (
            <li key={channel}>
              <StatusChip status={result.ok ? 'ok' : 'danger'}>
                {channel.toUpperCase()}: {result.ok ? 'OK' : 'Failed'} · {result.ms}ms
                {result.reason ? ` — ${result.reason}` : ''}
                {result.ok && result.delivered === false
                  ? ' — credentials verified, not delivered'
                  : ''}
              </StatusChip>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function clock(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The calls in the alerting plane's recency window, as one-tap choices for the Dispatch ID
 * field. Quiet when the list can't load - the typed fields still work on their own.
 */
function ActiveCallPicker({
  selected,
  onPick,
}: {
  selected: string;
  onPick: (dispatchId: string) => void;
}) {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['alerting', 'dispatches', 'active'],
    queryFn: () => listActiveDispatches(auth),
  });
  const dispatches = query.data?.dispatches ?? [];
  if (dispatches.length === 0) return null;

  return (
    <div className={styles.picker}>
      <p className={styles.pickerLabel}>Recent calls</p>
      <ul className={styles.chipRow}>
        {[...dispatches]
          .sort((a, b) => b.dispatchedAt - a.dispatchedAt)
          .map((dispatch) => (
            <li key={dispatch.dispatchId}>
              <Button
                variant={dispatch.dispatchId === selected ? 'primary' : 'secondary'}
                size="sm"
                aria-pressed={dispatch.dispatchId === selected}
                onClick={() => onPick(dispatch.dispatchId)}
              >
                {dispatch.incidentType ?? 'Call'} · {dispatch.address ?? dispatch.dispatchId} ·{' '}
                {clock(dispatch.dispatchedAt)}
              </Button>
            </li>
          ))}
      </ul>
    </div>
  );
}

// #160/#159: web /alerts/diagnostics (officer, chief, admin) - member+dispatch self-diagnosis
// timeline and the N8.3 canary health panel. Follows AlertsRosterPage.tsx's shape (type-and-the
// -view-updates, no submit button) - the diagnostics query only enables once both identifiers
// are entered.
export function AlertsDiagnosticsPage() {
  const auth = useAuth();
  // The roster's per-member "Diagnose" link lands here with both ids in the URL.
  const [searchParams] = useSearchParams();
  const [dispatchId, setDispatchId] = useState(searchParams.get('dispatchId') ?? '');
  const [memberId, setMemberId] = useState(searchParams.get('memberId') ?? '');
  const membersListId = useId();
  const members = useQuery({
    queryKey: ['personnel', 'members'],
    queryFn: () => listMembers(auth),
    staleTime: 60_000,
  });

  return (
    <main id="main-content">
      <PageHeader
        title="Alert diagnostics"
        description="Trace one member's page for one call, and check that alerting is healthy right now."
      />

      <div className={styles.grid}>
        <div className={styles.column}>
          <Card title="Look up a delivery">
            <ActiveCallPicker selected={dispatchId.trim()} onPick={setDispatchId} />
            <div className={styles.formGrid}>
              <TextInput
                label="Dispatch ID"
                value={dispatchId}
                onChange={(e) => setDispatchId(e.target.value)}
              />
              <TextInput
                label="Member ID"
                help={members.data ? 'Start typing a name to pick from the roster.' : undefined}
                value={memberId}
                list={members.data ? membersListId : undefined}
                onChange={(e) => setMemberId(e.target.value)}
              />
              {members.data ? (
                <datalist id={membersListId}>
                  {members.data.map((member) => (
                    <option key={member.memberId} value={member.memberId}>
                      {member.lastName}, {member.firstName} · {member.rank}
                    </option>
                  ))}
                </datalist>
              ) : null}
            </div>
            {dispatchId.trim() && memberId.trim() ? null : (
              <p className={styles.lookupHelp}>
                Enter a dispatch and member to see their delivery timeline and device checks.
              </p>
            )}
          </Card>

          {dispatchId.trim() && memberId.trim() ? (
            <TimelineTable dispatchId={dispatchId.trim()} memberId={memberId.trim()} />
          ) : null}
        </div>

        <div className={styles.column}>
          <CanaryPanel />
        </div>
      </div>
    </main>
  );
}
