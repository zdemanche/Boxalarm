import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, Skeleton, Stat } from '../../components/ui';
import { ApiError } from '../../lib/apiClient';
import { canAccessPath } from '../../routing/routeTable';
import { getNerisCompliance } from './api';
import type { NerisOpenDraft } from './types';
import styles from './NerisComplianceTile.module.css';

/** The oldest drafts named on the tile; the rest are counted. */
const DRAFTS_SHOWN = 3;
/** The server caps openDrafts at this many. */
const DRAFTS_CAP = 20;
/** NERIS expects a report within 72 hours; older drafts are flagged. */
const DUE_HOURS = 72;

function formatAge(hours: number): string {
  if (hours < 48) return `${Math.max(0, Math.round(hours))} h old`;
  return `${Math.floor(hours / 24)} days old`;
}

function DraftItem({ draft, canOpen }: { draft: NerisOpenDraft; canOpen: boolean }) {
  const label = `Incident ${draft.id}`;
  return (
    <li className={styles.item}>
      {canOpen ? (
        <Link to={`/incidents/${encodeURIComponent(draft.id)}`}>{label}</Link>
      ) : (
        <strong>{label}</strong>
      )}
      <span className={styles.meta}>
        {' · '}
        {formatAge(draft.ageHours)} · {draft.ownerName?.trim() || 'Unknown member'}
        {draft.locked ? ' · locked' : ''}
      </span>
    </li>
  );
}

/**
 * Chief-dashboard tile for GET reporting/neris-compliance: on-time submission rate, rejection
 * rate and the oldest open drafts. A failed read never renders as a healthy zero.
 */
export function NerisComplianceTile() {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['reporting', 'neris-compliance'],
    queryFn: () => getNerisCompliance(auth),
  });
  const canOpen = canAccessPath('/incidents/x', auth.roles);

  let body: ReactNode;
  if (query.isLoading) {
    body = <Skeleton lines={2} />;
  } else if (query.error || !query.data) {
    body =
      query.error instanceof ApiError && query.error.problem.status === 403 ? (
        <p className={styles.message}>You don&rsquo;t have access to NERIS compliance.</p>
      ) : (
        <div className={styles.error}>
          <p className={styles.message}>
            Couldn&rsquo;t load NERIS compliance. This is not an empty result.
          </p>
          <Button variant="secondary" onClick={() => void query.refetch()}>
            Retry NERIS compliance
          </Button>
        </div>
      );
  } else {
    const data = query.data;
    const drafts = data.openDrafts;
    const draftCount = drafts.length >= DRAFTS_CAP ? `${DRAFTS_CAP}+` : String(drafts.length);
    body = (
      <>
        <div className={styles.statGrid}>
          <Stat
            label="Submitted within 72 h"
            value={data.submittedWithin72hPct === null ? '—' : `${data.submittedWithin72hPct}%`}
            hint={
              data.submittedWithin72hPct === null
                ? `No reports fell due in the last ${data.windowDays} days.`
                : `Of ${data.eligibleCount} reports due in the last ${data.windowDays} days.`
            }
          />
          <Stat
            label="Rejection rate"
            value={data.rejectionRate === null ? '—' : `${data.rejectionRate}%`}
            hint={
              data.rejectionRate === null
                ? `Nothing was submitted to NERIS in the last ${data.windowDays} days.`
                : `${data.rejectedCount} of ${data.submittedCount} submitted were returned${
                    data.validationRejectedCount > 0
                      ? `, including ${data.validationRejectedCount} refused by NERIS validation when sent`
                      : ''
                  }.`
            }
            alarm={(data.rejectionRate ?? 0) > 0}
          />
          <Stat
            label="Open drafts"
            value={draftCount}
            alarm={drafts.some((draft) => draft.ageHours > DUE_HOURS)}
          />
        </div>
        {drafts.length === 0 ? (
          <p className={styles.message}>No open incident drafts.</p>
        ) : (
          <>
            <p className={styles.message}>Oldest open drafts:</p>
            <ul className={styles.list} aria-label="Oldest open drafts">
              {drafts.slice(0, DRAFTS_SHOWN).map((draft) => (
                <DraftItem key={draft.id} draft={draft} canOpen={canOpen} />
              ))}
            </ul>
          </>
        )}
      </>
    );
  }

  return <Card title="NERIS compliance">{body}</Card>;
}
