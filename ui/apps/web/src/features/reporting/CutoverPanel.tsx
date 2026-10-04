import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { canRecordCutoverDecision } from '../../auth/roles';
import { Button, Card, ConfirmDialog, DataTable, Stat, StatusChip } from '../../components/ui';
import { getCutoverDecision, recordCutoverDecision } from './api';
import {
  formatDate,
  formatDuration,
  formatPercent,
  isoDateDaysAgo,
  isoDateToEpochSeconds,
  todayIsoDate,
} from './format';
import { QueryState, useDateRange } from './ReportingPage';
import type { CutoverDecisionStatus } from './types';
import styles from './ReportingPage.module.css';

function decisionLabel(decision: CutoverDecisionStatus | null): string {
  if (decision === 'accept') return 'Accepted';
  if (decision === 'defer') return 'Deferred';
  return 'Not yet decided';
}

/**
 * N1.9 cutover report + the chief/admin accept-or-defer decision (#161, E1-S15-UI). Everyone who
 * can read reports sees the delivery-rate comparison against tone-out; only CHIEF/ADMIN
 * (Cedar RecordCutoverDecision) can record a decision. Deciding is never the same thing as
 * turning off radio tone-out — N1.9 keeps retained parallel tone-out paging as the compensating
 * control regardless of this decision (CLAUDE.md), and the copy below says so rather than
 * implying otherwise.
 */
export function CutoverPanel() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canDecide = canRecordCutoverDecision(auth.roles);
  const range = useDateRange(isoDateDaysAgo(30), todayIsoDate());
  const from = isoDateToEpochSeconds(range.from);
  const to = isoDateToEpochSeconds(range.to) + 86_399;

  const query = useQuery({
    queryKey: ['reporting', 'cutover-decision', from, to],
    queryFn: () => getCutoverDecision(auth, from, to),
    enabled: range.valid,
  });

  const [confirming, setConfirming] = useState<CutoverDecisionStatus | null>(null);
  const mutation = useMutation({
    mutationFn: (decision: CutoverDecisionStatus) => recordCutoverDecision(auth, decision),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['reporting', 'cutover-decision'] });
    },
  });

  return (
    <>
      {range.fields}
      {range.valid ? (
        <QueryState query={query}>
          {(view) => (
            <div className={styles.sections}>
              <Card title="Cutover decision">
                <div className={styles.statGrid}>
                  <Stat label="Decision" value={decisionLabel(view.decision)} />
                  <Stat
                    label="Decided by"
                    value={view.decider ?? '—'}
                    hint={view.decidedAt ? formatDate(view.decidedAt) : undefined}
                  />
                  <Stat
                    label="Retained paging"
                    value={
                      <StatusChip status={view.retainedPagingRequired ? 'warning' : 'ok'}>
                        {view.retainedPagingRequired ? 'Still required' : 'Not required'}
                      </StatusChip>
                    }
                  />
                </div>
                <p className={styles.meta}>
                  Radio tone-out paging is a department operational decision made outside this app
                  (N1.9) — this page records only whether Boxalarm&apos;s own delivery data has been
                  accepted as meeting the department&apos;s threshold. Accepting this decision does
                  not disable, pause, or otherwise change tone-out paging.
                </p>
                {canDecide ? (
                  <>
                    <div className={styles.decisionRow}>
                      <Button
                        variant="primary"
                        onClick={() => setConfirming('accept')}
                        disabled={mutation.isPending}
                      >
                        Accept cutover data
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => setConfirming('defer')}
                        disabled={mutation.isPending}
                      >
                        Defer
                      </Button>
                    </div>
                    {mutation.isError ? (
                      <p role="alert" className={styles.warning}>
                        Could not record the decision. Try again.
                      </p>
                    ) : null}
                  </>
                ) : null}
              </Card>
              {view.deliveryBaseline ? (
                <Card title="Delivery-rate baseline">
                  <div className={styles.statGrid}>
                    <Stat
                      label="Delivery rate"
                      value={formatPercent(view.deliveryBaseline.deliveryRate)}
                      alarm={!view.deliveryBaseline.meetsThreshold}
                      hint={`Threshold ${formatPercent(view.deliveryBaseline.threshold)}`}
                    />
                    <Stat
                      label="Missed pages"
                      value={view.deliveryBaseline.missedPageCount}
                      alarm={view.deliveryBaseline.missedPageCount > 0}
                    />
                    <Stat
                      label="Time to first ack (median)"
                      value={formatDuration(view.deliveryBaseline.timeToFirstAckMedianSeconds)}
                      hint={`Average ${formatDuration(view.deliveryBaseline.timeToFirstAckAverageSeconds)}`}
                    />
                  </div>
                  <div className={styles.sections}>
                    <DataTable
                      caption="Delivery rate by member"
                      rowKey={(r) => r.memberId}
                      rows={view.deliveryBaseline.perMember}
                      emptyMessage="No pages were sent in this period."
                      columns={[
                        {
                          key: 'member',
                          header: 'Member',
                          isRowHeader: true,
                          render: (r) => r.memberId,
                        },
                        { key: 'sent', header: 'Sent', align: 'right', render: (r) => r.sent },
                        {
                          key: 'delivered',
                          header: 'Delivered',
                          align: 'right',
                          render: (r) => r.delivered,
                        },
                        {
                          key: 'missed',
                          header: 'Missed',
                          align: 'right',
                          render: (r) => r.missedPageCount,
                        },
                        {
                          key: 'rate',
                          header: 'Rate',
                          align: 'right',
                          sortValue: (r) => r.deliveryRate,
                          render: (r) => formatPercent(r.deliveryRate),
                        },
                      ]}
                    />
                  </div>
                </Card>
              ) : null}
            </div>
          )}
        </QueryState>
      ) : null}
      <ConfirmDialog
        open={confirming === 'accept'}
        onOpenChange={(open) => setConfirming(open ? 'accept' : null)}
        title="Accept Boxalarm's cutover delivery data?"
        consequence="Records that the department accepts Boxalarm's measured delivery data as meeting the cutover threshold. This does not disable, pause, or change radio tone-out paging — that remains a separate department decision (N1.9)."
        confirmLabel="Accept"
        onConfirm={async () => {
          await mutation.mutateAsync('accept');
        }}
      />
      <ConfirmDialog
        open={confirming === 'defer'}
        onOpenChange={(open) => setConfirming(open ? 'defer' : null)}
        title="Defer the cutover decision?"
        consequence="Records that the department is not yet accepting Boxalarm's delivery data as the basis for cutover. Retained paging stays required. This can be revisited at any time by accepting later."
        confirmLabel="Defer"
        onConfirm={async () => {
          await mutation.mutateAsync('defer');
        }}
      />
    </>
  );
}
