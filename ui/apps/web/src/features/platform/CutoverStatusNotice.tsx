import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Card, Skeleton, StatusChip } from '../../components/ui';
import { getCutoverDecision } from '../reporting/api';

/**
 * #161 (E1-S15-UI): tells ADMIN whether retained paging is still required under the N1.9 parallel
 * run, without ever implying radio tone-out has been turned off — that stays a department
 * decision outside this app regardless of the recorded cutover decision (CLAUDE.md). Reads the
 * decision only (no `from`/`to`), so this never fetches the delivery baseline just to show a
 * one-line status; the full report lives on Reporting → Cutover.
 */
export function CutoverStatusNotice() {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['reporting', 'cutover-decision', 'status-only'],
    queryFn: () => getCutoverDecision(auth),
  });

  return (
    <Card title="Cutover">
      {query.isLoading ? (
        <Skeleton lines={2} />
      ) : (
        <ApiForbiddenGate error={query.error} embedded>
          {query.data ? (
            <>
              {query.data.retainedPagingRequired ? (
                <p role="status">
                  <StatusChip status="warning">Still required</StatusChip> Retained radio tone-out
                  paging is still required — the department has not accepted Boxalarm&apos;s
                  delivery data as meeting the N1.9 cutover threshold.
                </p>
              ) : (
                <p role="status">
                  <StatusChip status="ok">Not required</StatusChip> The department has accepted
                  Boxalarm&apos;s delivery data for cutover. This records that decision only — it
                  does not disable, pause, or otherwise change radio tone-out paging, which remains
                  a separate department decision.
                </p>
              )}
              <Link to="/reporting">See the full cutover report</Link>
            </>
          ) : null}
        </ApiForbiddenGate>
      )}
    </Card>
  );
}
