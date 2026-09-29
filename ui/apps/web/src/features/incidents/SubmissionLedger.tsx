import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { StatusRole } from '@boxalarm/design-tokens';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { Button } from '../../components/ui/Button';
import { StatusChip } from '../../components/ui/Chip';
import { DataTable } from '../../components/ui/DataTable';
import { resubmitIncident } from './api';
import { formatTimestamp } from './format';
import type {
  AttemptOutcome,
  NerisStatus,
  ResubmitResponse,
  SubmissionAttempt,
  SubmissionState,
} from './types';
import styles from './IncidentDetail.module.css';

const NERIS_STATUS: Record<NerisStatus, { role: StatusRole; label: string }> = {
  SUBMITTED: { role: 'info', label: 'Received by NERIS' },
  PENDING_INCIDENT_DATA: { role: 'warning', label: 'NERIS needs more incident data' },
  PENDING_APPROVAL: { role: 'warning', label: 'Waiting for NERIS approval' },
  APPROVED: { role: 'ok', label: 'Approved by NERIS' },
  REJECTED: { role: 'danger', label: 'Returned by NERIS' },
  FAILED: { role: 'danger', label: 'Failed in NERIS' },
  DELETED: { role: 'neutral', label: 'Deleted in NERIS' },
};

const OUTCOME_LABEL: Record<AttemptOutcome, string> = {
  SUCCESS: 'Accepted',
  RATE_LIMITED: 'Rate limited, retried later',
  VALIDATION_ERROR: 'Rejected by NERIS validation',
  SERVER_ERROR: 'NERIS server error',
  CLIENT_ERROR: 'Request error',
  NOT_CONFIGURED: 'NERIS not configured',
};

function nerisStatusView(status: string): { role: StatusRole; label: string } {
  return NERIS_STATUS[status as NerisStatus] ?? { role: 'neutral', label: status };
}

function isoTime(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : iso;
}

function diffValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '(empty)';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function attemptErrors(attempt: SubmissionAttempt) {
  if (attempt.errors.length === 0) return attempt.failureReason ?? '—';
  return (
    <ul className={styles.plainList}>
      {attempt.errors.map((error, index) => (
        <li key={`${error.path}-${error.code}-${index}`}>
          {error.path ? <span className={styles.mono}>{error.path}</span> : null}
          {error.path ? ': ' : null}
          {error.message}
        </li>
      ))}
    </ul>
  );
}

/** The NERIS submission ledger: status, NERIS id, resubmit, every attempt, and status history. */
export function SubmissionLedger({
  state,
  locked,
}: {
  state: SubmissionState;
  /** Resubmit is only offered on a locked report NERIS already holds. */
  locked: boolean;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [resubmitting, setResubmitting] = useState(false);
  const [result, setResult] = useState<ResubmitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nerisStatus = state.nerisStatus ?? null;
  const attempts = state.attempts ?? [];
  const history = state.statusHistory ?? [];
  const canResubmit = locked && Boolean(state.nerisIncidentId);

  async function resubmit() {
    setResubmitting(true);
    setError(null);
    setResult(null);
    try {
      const response = await resubmitIncident(auth, state.incidentId);
      setResult(response);
      await queryClient.invalidateQueries({
        queryKey: ['incident-submission', state.incidentId],
      });
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? (caught.problem.detail ?? caught.problem.title)
          : 'Unable to resubmit the report to NERIS.',
      );
    } finally {
      setResubmitting(false);
    }
  }

  return (
    <section className={styles.ledger} aria-labelledby="neris-ledger-heading">
      <h3 id="neris-ledger-heading">NERIS submission record</h3>
      <dl className={styles.facts}>
        <div>
          <dt>NERIS status</dt>
          <dd>
            {nerisStatus ? (
              <StatusChip status={nerisStatusView(nerisStatus).role}>
                {nerisStatusView(nerisStatus).label}
              </StatusChip>
            ) : (
              'Not reported by NERIS yet'
            )}
            {nerisStatus && state.nerisStatusAt ? (
              <span className={styles.count}> as of {formatTimestamp(state.nerisStatusAt)}</span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>NERIS incident ID</dt>
          <dd className={styles.mono}>{state.nerisIncidentId ?? 'Not assigned yet'}</dd>
        </div>
        {state.firstSubmittedAt ? (
          <div>
            <dt>First sent</dt>
            <dd>{formatTimestamp(state.firstSubmittedAt)}</dd>
          </div>
        ) : null}
      </dl>

      {state.editedSinceSubmission ? (
        <p className={styles.notice}>
          This report was edited after it was last sent to NERIS. NERIS still has the older version.
        </p>
      ) : null}
      {canResubmit ? (
        <div className={styles.actions}>
          <Button type="button" loading={resubmitting} onClick={() => void resubmit()}>
            Resubmit to NERIS
          </Button>
        </div>
      ) : null}
      <div aria-live="polite">
        {result ? (
          result.status === 'UNCHANGED' || result.diff.length === 0 ? (
            <p>No changes to send. NERIS already has this version.</p>
          ) : (
            <>
              <p>
                Sent {result.diff.length} {result.diff.length === 1 ? 'change' : 'changes'} to
                NERIS:
              </p>
              <ul className={styles.plainList}>
                {result.diff.map((entry) => (
                  <li key={entry.path}>
                    <span className={styles.mono}>{entry.path}</span>: {diffValue(entry.before)} →{' '}
                    {diffValue(entry.after)}
                  </li>
                ))}
              </ul>
            </>
          )
        ) : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}

      <DataTable
        caption="Submission attempts"
        rowKey={(row) => String(row.attempt)}
        rows={attempts}
        emptyMessage="No submission attempts yet."
        columns={[
          {
            key: 'time',
            header: 'Time',
            isRowHeader: true,
            render: (row) => isoTime(row.attemptedAt),
          },
          {
            key: 'operation',
            header: 'Operation',
            render: (row) =>
              row.operation === 'UPDATE' ? 'Update' : row.operation === 'CREATE' ? 'Create' : '—',
          },
          {
            key: 'outcome',
            header: 'Outcome',
            render: (row) => OUTCOME_LABEL[row.outcome] ?? row.outcome,
          },
          {
            key: 'http',
            header: 'HTTP',
            align: 'right',
            render: (row) => (row.httpStatus === null ? '—' : String(row.httpStatus)),
          },
          { key: 'errors', header: 'Errors', render: attemptErrors },
        ]}
      />

      <h4 className={styles.subheading}>Status history</h4>
      {history.length === 0 ? (
        <p>No status changes recorded yet.</p>
      ) : (
        <ol className={styles.timeline}>
          {history.map((entry, index) => (
            <li key={`${entry.status}-${entry.at}-${index}`}>
              <strong>{nerisStatusView(entry.status).label}</strong>{' '}
              <span className={styles.count}>{isoTime(entry.at)}</span>
              {entry.current ? <span> (current)</span> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
