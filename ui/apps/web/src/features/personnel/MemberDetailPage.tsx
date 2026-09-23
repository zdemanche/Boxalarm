import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { getMember, updateMemberStatus } from './api';
import type { MemberStatus } from './types';

const STATUSES: MemberStatus[] = ['PROBATIONARY', 'ACTIVE', 'LOA', 'RETIRED'];

export function MemberDetailPage() {
  const { id = '' } = useParams();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = auth.roles.includes('ADMIN');

  const memberQuery = useQuery({
    queryKey: ['personnel', 'members', id],
    queryFn: () => getMember(auth, id),
    enabled: Boolean(id),
  });

  const statusMutation = useMutation({
    mutationFn: (status: MemberStatus) => updateMemberStatus(auth, id, status),
    onSuccess: (member) => {
      queryClient.setQueryData(['personnel', 'members', id], member);
      void queryClient.invalidateQueries({ queryKey: ['personnel', 'members'] });
    },
  });

  if (memberQuery.error) {
    return (
      <ApiForbiddenGate error={memberQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const member = memberQuery.data;

  return (
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      <p>
        <Link to="/personnel">← Personnel</Link>
      </p>
      {memberQuery.isLoading || !member ? (
        <p>Loading member…</p>
      ) : (
        <>
          <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>
            {member.firstName} {member.lastName}
          </h1>
          <dl style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
            <dt>Status</dt>
            <dd>{member.status}</dd>
            <dt>Email</dt>
            <dd>{member.email}</dd>
            <dt>Phone</dt>
            <dd>{member.phone}</dd>
            <dt>Rank</dt>
            <dd>{member.rank}</dd>
            <dt>Agency ID</dt>
            <dd>{member.agencyId}</dd>
            <dt>Join date</dt>
            <dd>{member.joinDate}</dd>
          </dl>

          {isAdmin ? (
            <label
              style={{
                display: 'grid',
                gap: 4,
                maxWidth: 320,
                marginTop: 'var(--boxalarm-spacing-lg)',
              }}
            >
              Change status
              <select
                aria-label="Member status"
                value={member.status}
                disabled={statusMutation.isPending}
                onChange={(e) => statusMutation.mutate(e.target.value as MemberStatus)}
                style={{ minHeight: 44 }}
              >
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {statusMutation.error ? (
            <ApiForbiddenGate error={statusMutation.error} embedded>
              <p role="alert">{statusMutation.error.message}</p>
            </ApiForbiddenGate>
          ) : null}
        </>
      )}
    </main>
  );
}
