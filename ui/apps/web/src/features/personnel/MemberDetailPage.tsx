import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Badge } from '../../components/ui/Chip';
import { PageHeader } from '../../components/ui/PageHeader';
import { revokeMemberSessions } from '../platform/api';
import { getMember, updateMemberStatus } from './api';
import type { MemberStatus } from './types';

const STATUSES: MemberStatus[] = ['PROBATIONARY', 'ACTIVE', 'LOA', 'RETIRED'];

export function MemberDetailPage() {
  const { id = '' } = useParams();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = auth.roles.includes('ADMIN');
  const canRevokeSessions = auth.roles.includes('ADMIN') || auth.roles.includes('CHIEF');
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeForbidden, setRevokeForbidden] = useState<unknown>(null);
  const [revoked, setRevoked] = useState(false);

  const revokeMutation = useMutation({
    mutationFn: () => revokeMemberSessions(auth, id),
    onSuccess: () => {
      setRevokeError(null);
      setRevokeForbidden(null);
      setRevoked(true);
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.problem.status === 403) {
        setRevokeError(null);
        setRevokeForbidden(error);
        return;
      }
      setRevokeForbidden(null);
      setRevokeError('Could not revoke this member’s sessions. Try again.');
    },
  });

  function handleRevoke() {
    if (
      window.confirm('Revoke all sessions for this member? They will be signed out everywhere.')
    ) {
      setRevoked(false);
      revokeMutation.mutate();
    }
  }

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
    <main id="main-content">
      <PageHeader
        title={member ? `${member.firstName} ${member.lastName}` : '…'}
        breadcrumbs={[
          { label: 'Personnel', to: '/personnel' },
          { label: member ? `${member.firstName} ${member.lastName}` : '…' },
        ]}
        actions={member ? <Badge>{member.status}</Badge> : undefined}
      />
      {memberQuery.isLoading || !member ? (
        <p>Loading member…</p>
      ) : (
        <>
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'max-content 1fr',
              columnGap: 'var(--bx-space-lg)',
              rowGap: 'var(--bx-space-sm)',
              fontSize: 14,
            }}
          >
            <dt style={{ color: 'var(--bx-fg-muted)' }}>Email</dt>
            <dd style={{ margin: 0 }}>{member.email}</dd>
            <dt style={{ color: 'var(--bx-fg-muted)' }}>Phone</dt>
            <dd style={{ margin: 0, fontFamily: 'var(--bx-font-mono)' }}>{member.phone}</dd>
            <dt style={{ color: 'var(--bx-fg-muted)' }}>Rank</dt>
            <dd style={{ margin: 0 }}>{member.rank}</dd>
            <dt style={{ color: 'var(--bx-fg-muted)' }}>Agency ID</dt>
            <dd style={{ margin: 0 }}>{member.agencyId}</dd>
            <dt style={{ color: 'var(--bx-fg-muted)' }}>Join date</dt>
            <dd style={{ margin: 0 }}>{member.joinDate}</dd>
          </dl>

          {isAdmin ? (
            <label
              style={{
                display: 'grid',
                gap: 4,
                maxWidth: 320,
                marginTop: 'var(--bx-space-lg)',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Change status
              <select
                aria-label="Member status"
                value={member.status}
                disabled={statusMutation.isPending}
                onChange={(e) => statusMutation.mutate(e.target.value as MemberStatus)}
                style={{
                  minHeight: 'var(--bx-target-office)',
                  padding: '0 var(--bx-space-sm)',
                  fontSize: 14,
                  fontWeight: 400,
                  background: 'var(--bx-surface-raised)',
                  color: 'var(--bx-fg)',
                  border: '1px solid var(--bx-border)',
                  borderRadius: 'var(--bx-radius-md)',
                }}
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

          {canRevokeSessions ? (
            <div style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
              <button
                type="button"
                onClick={handleRevoke}
                disabled={revokeMutation.isPending}
                style={{ minHeight: 44 }}
              >
                Revoke all sessions (lost device)
              </button>
              {revokeForbidden ? (
                <ApiForbiddenGate error={revokeForbidden} embedded>
                  <p role="alert">Could not revoke this member’s sessions.</p>
                </ApiForbiddenGate>
              ) : null}
              {revokeError ? (
                <p role="alert" aria-live="assertive">
                  {revokeError}
                </p>
              ) : null}
              {revoked ? <p role="status">Sessions revoked.</p> : null}
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}
