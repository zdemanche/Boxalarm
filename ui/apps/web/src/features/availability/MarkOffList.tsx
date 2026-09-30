import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Button } from '../../components/ui';
import { ApiError } from '../../lib/apiClient';
import { endMarkOff, listMarkOffs, type ListedMarkOff } from './api';

function when(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const markOffsQueryKey = (memberId: string) => ['availability', 'markoffs', memberId];

/**
 * A member's current and upcoming mark-offs, each with "End now" (paging review MAJOR-A). A
 * mark-off stops the member's call alerts, so ending one is how they are paged again before its
 * end time. Shown to the member on My availability, and to an officer on the member's page.
 */
export function MarkOffList({ memberId, ownRecord }: { memberId: string; ownRecord: boolean }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const query = useQuery({
    queryKey: markOffsQueryKey(memberId),
    queryFn: () => listMarkOffs(auth, memberId),
  });
  const end = useMutation({
    mutationFn: (markOff: ListedMarkOff) => endMarkOff(auth, memberId, markOff.markoffId),
    onSuccess: async (_data, markOff) => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      setMessage(
        markOff.startAt > nowSeconds
          ? 'That mark-off is cancelled.'
          : ownRecord
            ? 'You’re available again: calls alert you from now on.'
            : 'The member is available again: calls alert them from now on.',
      );
      await queryClient.invalidateQueries({ queryKey: markOffsQueryKey(memberId) });
    },
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const markOffs = query.data ?? [];

  return (
    <section aria-labelledby={`markoffs-${memberId}`}>
      <h2 id={`markoffs-${memberId}`} style={{ fontSize: 'var(--boxalarm-font-size-lg)' }}>
        {ownRecord ? 'Your mark-offs' : 'Mark-offs'}
      </h2>
      {query.isLoading ? <p>Loading mark-offs…</p> : null}
      {query.error ? (
        <p role="alert">
          {query.error instanceof ApiError && query.error.problem.status === 403
            ? 'You do not have access to this member’s mark-offs.'
            : 'Mark-offs could not be loaded. Try again.'}
        </p>
      ) : null}
      {query.isSuccess && markOffs.length === 0 ? (
        <p>{ownRecord ? 'You’re not marked off.' : 'Not marked off.'}</p>
      ) : null}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {markOffs.map((markOff) => {
          const current = markOff.startAt <= nowSeconds;
          return (
            <li
              key={markOff.markoffId}
              style={{ display: 'flex', gap: 12, alignItems: 'center', minHeight: 44 }}
            >
              <span>
                {current
                  ? `Marked off now, until ${when(markOff.endAt)}`
                  : `${when(markOff.startAt)} until ${when(markOff.endAt)}`}
                {markOff.reason ? ` · ${markOff.reason}` : ''}
              </span>
              <Button
                variant="secondary"
                loading={end.isPending && end.variables?.markoffId === markOff.markoffId}
                onClick={() => end.mutate(markOff)}
                aria-label={
                  current
                    ? `End the mark-off until ${when(markOff.endAt)} now`
                    : `Cancel the mark-off from ${when(markOff.startAt)}`
                }
              >
                {current ? 'End now' : 'Cancel'}
              </Button>
            </li>
          );
        })}
      </ul>
      {end.error ? <p role="alert">The mark-off could not be ended. Try again.</p> : null}
      <p role="status" aria-live="polite">
        {message}
      </p>
    </section>
  );
}
