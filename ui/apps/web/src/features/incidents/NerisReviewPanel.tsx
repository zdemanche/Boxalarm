import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { canLockIncident, canUnlockIncident } from '../../auth/roles';
import { ApiError } from '../../lib/apiClient';
import { Button } from '../../components/ui/Button';
import { StatusChip } from '../../components/ui/Chip';
import { Dialog } from '../../components/ui/Dialog';
import { Checkbox, Textarea } from '../../components/ui/Field';
import {
  lockIncident,
  lockRefusalFrom,
  problemCode,
  unlockIncident,
  validateIncident,
} from './api';
import { applyValidationFix } from './reviewFix';
import type {
  IncidentDetail,
  ValidationIssue,
  ValidationMode,
  ValidationReport,
  ValidationSection,
} from './types';
import { MAX_UNLOCK_REASON_LENGTH, MIN_UNLOCK_REASON_LENGTH, VALIDATION_SECTIONS } from './types';
import styles from './IncidentDetail.module.css';

export const SECTION_LABEL: Record<ValidationSection, string> = {
  core: 'Core',
  dispatch: 'Dispatch',
  units: 'Units',
  narrative: 'Narrative',
  fire: 'Fire',
  neris: 'NERIS',
};

function problemText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.problem.detail ?? error.problem.title;
  return error instanceof Error ? error.message : fallback;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function issueKey(kind: 'blocking' | 'warning', issue: ValidationIssue, index: number): string {
  return `${kind}-${issue.path}-${issue.code}-${index}`;
}

type Report = Pick<ValidationReport, 'blocking' | 'warnings' | 'sectionsComplete'> &
  Partial<Pick<ValidationReport, 'nerisValidatedAt'>>;

/**
 * The officer review: "what's blocking lock" checklist, one-tap fixes, the attested lock, and the
 * chief/admin unlock. Validation results and lock outcomes are announced politely.
 */
export function NerisReviewPanel({
  incident,
  onPatched,
  onGoTo,
}: {
  incident: IncidentDetail;
  /** Merge a server response into the cached incident. */
  onPatched: (patch: Partial<IncidentDetail>) => void;
  /** Move to the report step (and field) an issue points at. */
  onGoTo: (issue: ValidationIssue) => void;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const incidentId = incident.incidentId;
  const locked = typeof incident.lockedAt === 'number';
  const canLock = canLockIncident(auth.roles);
  const canUnlock = canUnlockIncident(auth.roles);
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  const [mode, setMode] = useState<ValidationMode>('local');
  const [lockRefusal, setLockRefusal] = useState<Report | null>(null);
  const [message, setMessage] = useState('');
  const [fixing, setFixing] = useState<string | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [attested, setAttested] = useState(false);
  const [locking, setLocking] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const validation = useQuery({
    queryKey: ['incident-validation', incidentId, mode],
    queryFn: () => validateIncident(auth, incidentId, mode),
  });

  // After an unlock the Unlock button is gone; put focus back on the checklist heading.
  const wasLocked = useRef(locked);
  useEffect(() => {
    if (wasLocked.current && !locked) {
      const timer = window.setTimeout(() => headingRef.current?.focus(), 0);
      wasLocked.current = locked;
      return () => window.clearTimeout(timer);
    }
    wasLocked.current = locked;
    return undefined;
  }, [locked]);

  const report: Report | undefined = lockRefusal ?? validation.data;
  const blocking = report?.blocking ?? [];
  const warnings = report?.warnings ?? [];

  function recheck(next: ValidationMode) {
    setLockRefusal(null);
    setFixError(null);
    setMessage('');
    if (next === mode) void validation.refetch();
    else setMode(next);
  }

  async function applyFix(issue: ValidationIssue, key: string) {
    if (!issue.fix) return;
    setFixing(key);
    setFixError(null);
    try {
      const patch = await applyValidationFix(auth, incident, issue.fix);
      onPatched(patch);
      setLockRefusal(null);
      setMessage(`Fixed: ${issue.fix.label}. Checking again.`);
      await queryClient.invalidateQueries({ queryKey: ['incident-validation', incidentId] });
      headingRef.current?.focus();
    } catch (error) {
      if (problemCode(error) === 'INCIDENT_LOCKED') {
        void queryClient.invalidateQueries({ queryKey: ['incident', incidentId] });
      }
      const detail = problemText(error, 'Unable to apply the fix.');
      setFixError(detail);
      setMessage(detail);
    } finally {
      setFixing(null);
    }
  }

  async function lock() {
    setLocking(true);
    setLockError(null);
    try {
      const result = await lockIncident(auth, incidentId);
      setLockRefusal(null);
      setAttested(false);
      onPatched({ lockedAt: result.lockedAt, lockedBy: result.lockedBy, status: result.status });
      void queryClient.invalidateQueries({ queryKey: ['incident-submission', incidentId] });
      setMessage(
        result.submission
          ? 'Report locked and queued for NERIS. Edits are closed.'
          : 'Report locked. Edits are closed.',
      );
    } catch (error) {
      const refusal = lockRefusalFrom(error);
      if (refusal) {
        setLockRefusal(refusal);
        setMessage(
          `The report can't be locked yet: ${plural(refusal.blocking.length, 'item')} to fix.`,
        );
        headingRef.current?.focus();
        return;
      }
      const code = problemCode(error);
      if (code === 'ALREADY_LOCKED' || code === 'CHANGED_SINCE_REVIEW') {
        void queryClient.invalidateQueries({ queryKey: ['incident', incidentId] });
        void queryClient.invalidateQueries({ queryKey: ['incident-validation', incidentId] });
      }
      const detail = problemText(error, 'Unable to lock the report.');
      setLockError(detail);
      setMessage(detail);
    } finally {
      setLocking(false);
    }
  }

  function openUnlock() {
    setReason('');
    setReasonError(null);
    setUnlockError(null);
    setUnlockOpen(true);
  }

  async function unlock() {
    const trimmed = reason.trim();
    if (trimmed.length < MIN_UNLOCK_REASON_LENGTH) {
      setReasonError(
        `Enter a reason of at least ${MIN_UNLOCK_REASON_LENGTH} characters. It goes in the audit log.`,
      );
      reasonRef.current?.focus();
      return;
    }
    setUnlocking(true);
    setUnlockError(null);
    try {
      await unlockIncident(auth, incidentId, trimmed);
      setUnlockOpen(false);
      onPatched({ lockedAt: null, lockedBy: null });
      void queryClient.invalidateQueries({ queryKey: ['incident-validation', incidentId] });
      setMessage('Report unlocked. Edits are open again.');
    } catch (error) {
      setUnlockError(problemText(error, 'Unable to unlock the report.'));
    } finally {
      setUnlocking(false);
    }
  }

  function renderIssue(kind: 'blocking' | 'warning', issue: ValidationIssue, index: number) {
    const key = issueKey(kind, issue, index);
    const messageId = `${headingId}-${key}`;
    return (
      <li key={key} className={styles.issue}>
        <p id={messageId} className={styles.issueMessage}>
          <span className="visually-hidden">
            {kind === 'blocking' ? 'Blocking: ' : 'Warning: '}
          </span>
          {issue.message}
        </p>
        <div className={styles.actions}>
          <Button
            type="button"
            variant="secondary"
            aria-describedby={messageId}
            onClick={() => onGoTo(issue)}
          >
            Go to {SECTION_LABEL[issue.section]}
          </Button>
          {issue.fix && !locked ? (
            <Button
              type="button"
              aria-describedby={messageId}
              loading={fixing === key}
              onClick={() => void applyFix(issue, key)}
            >
              Fix: {issue.fix.label}
            </Button>
          ) : null}
        </div>
      </li>
    );
  }

  function renderChecklist() {
    if (validation.isLoading && !lockRefusal) {
      return <p aria-busy="true">Checking the report.</p>;
    }
    if (validation.error && !lockRefusal) {
      return (
        <p role="alert">
          {problemText(validation.error, 'Unable to check the report.')} This is not an all-clear.
        </p>
      );
    }
    return (
      <>
        {lockRefusal ? <p className={styles.refused}>Lock refused. Fix these first.</p> : null}
        {blocking.length === 0 ? (
          <p>Nothing blocking — ready to lock.</p>
        ) : (
          <>
            <h3 className={styles.subheading}>Blocking ({blocking.length})</h3>
            <ul className={styles.issueList}>
              {blocking.map((issue, index) => renderIssue('blocking', issue, index))}
            </ul>
          </>
        )}
        {warnings.length > 0 ? (
          <>
            <h3 className={styles.subheading}>Warnings ({warnings.length})</h3>
            <ul className={styles.issueList}>
              {warnings.map((issue, index) => renderIssue('warning', issue, index))}
            </ul>
          </>
        ) : null}
        <ul className={styles.chips} aria-label="Section completeness">
          {VALIDATION_SECTIONS.map((section) => {
            const complete = report?.sectionsComplete[section];
            return (
              <li key={section}>
                <StatusChip
                  status={complete === true ? 'ok' : complete === false ? 'warning' : 'neutral'}
                >
                  {SECTION_LABEL[section]}:{' '}
                  {complete === true
                    ? 'complete'
                    : complete === false
                      ? 'incomplete'
                      : 'not checked'}
                </StatusChip>
              </li>
            );
          })}
        </ul>
        {report?.nerisValidatedAt ? (
          <p className={styles.count}>
            Checked with NERIS at {new Date(report.nerisValidatedAt).toLocaleString()}.
          </p>
        ) : null}
      </>
    );
  }

  const summary =
    report && !validation.isFetching
      ? `${plural(blocking.length, 'item')} blocking lock, ${plural(warnings.length, 'warning')}.`
      : '';

  return (
    <section className={styles.review} aria-labelledby={headingId}>
      <h2 id={headingId} ref={headingRef} tabIndex={-1}>
        What&rsquo;s blocking lock
      </h2>
      <p className="visually-hidden" aria-live="polite">
        {message || summary}
      </p>
      {renderChecklist()}
      {fixError ? <p role="alert">{fixError}</p> : null}
      <div className={styles.actions}>
        <Button
          type="button"
          variant="secondary"
          loading={validation.isFetching && mode === 'local'}
          onClick={() => recheck('local')}
        >
          Check again
        </Button>
        <Button
          type="button"
          variant="secondary"
          loading={validation.isFetching && mode === 'both'}
          onClick={() => recheck('both')}
        >
          Check with NERIS
        </Button>
      </div>

      {locked ? (
        canUnlock ? (
          <div className={styles.actions}>
            <Button type="button" variant="secondary" onClick={openUnlock}>
              Unlock report
            </Button>
          </div>
        ) : (
          <p className={styles.count}>Only a chief or admin can unlock this report.</p>
        )
      ) : canLock ? (
        <div className={styles.lockBox}>
          <Checkbox
            label="I reviewed this report"
            checked={attested}
            onCheckedChange={setAttested}
          />
          <p id={`${headingId}-lock-help`} className={styles.count}>
            Locking closes every edit until a chief or admin unlocks it.
          </p>
          <div className={styles.actions}>
            <Button
              type="button"
              disabled={!attested}
              loading={locking}
              aria-describedby={`${headingId}-lock-help`}
              onClick={() => void lock()}
            >
              Lock report
            </Button>
          </div>
        </div>
      ) : null}
      {lockError ? <p role="alert">{lockError}</p> : null}

      <Dialog
        open={unlockOpen}
        onOpenChange={(open) => {
          if (!unlocking) setUnlockOpen(open);
        }}
        title="Unlock this report"
        description="Unlocking reopens every edit. Your reason is kept in the audit log."
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={unlocking}
              onClick={() => setUnlockOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              loading={unlocking}
              onClick={() => void unlock()}
            >
              Unlock
            </Button>
          </>
        }
      >
        <Textarea
          ref={reasonRef}
          label="Reason for unlocking"
          help={`At least ${MIN_UNLOCK_REASON_LENGTH} characters.`}
          required
          maxLength={MAX_UNLOCK_REASON_LENGTH}
          rows={4}
          value={reason}
          error={reasonError ?? undefined}
          onChange={(event) => {
            setReason(event.target.value);
            if (reasonError) setReasonError(null);
          }}
        />
        {unlockError ? <p role="alert">{unlockError}</p> : null}
      </Dialog>
    </section>
  );
}
