import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { issueMemberPpe, listMemberPpe } from '../inventory/api';
import type { IssuePpeInput } from '../inventory/types';
import { getMember, updateMemberStatus } from './api';
import type { MemberStatus } from './types';

const STATUSES: MemberStatus[] = ['PROBATIONARY', 'ACTIVE', 'LOA', 'RETIRED'];
const today = () => new Date().toISOString().slice(0, 10);
const emptyPpeForm: IssuePpeInput = { itemType: '', size: '', issueDate: today() };

export function MemberDetailPage() {
  const { id = '' } = useParams();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = auth.roles.includes('ADMIN');
  // Matches the inspections write-access precedent (ADMIN || CHIEF) — PPE issuance is a new
  // control added in this PR, unlike the pre-existing ADMIN-only member-status gate below.
  const canIssuePpe = isAdmin || auth.roles.includes('CHIEF');
  const [ppeForm, setPpeForm] = useState<IssuePpeInput>(emptyPpeForm);
  const [ppeFormError, setPpeFormError] = useState<string | null>(null);

  const memberQuery = useQuery({
    queryKey: ['personnel', 'members', id],
    queryFn: () => getMember(auth, id),
    enabled: Boolean(id),
  });

  const ppeQuery = useQuery({
    queryKey: ['inventory', 'ppe', id],
    queryFn: () => listMemberPpe(auth, id),
    enabled: Boolean(id),
  });

  const issuePpeMutation = useMutation({
    mutationFn: (input: IssuePpeInput) => issueMemberPpe(auth, id, input),
    onSuccess: async () => {
      setPpeForm(emptyPpeForm);
      setPpeFormError(null);
      await queryClient.invalidateQueries({ queryKey: ['inventory', 'ppe', id] });
    },
    onError: (error: Error) => setPpeFormError(error.message),
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

          <h2
            style={{
              fontSize: 'var(--boxalarm-font-size-lg)',
              marginTop: 'var(--boxalarm-spacing-xl)',
            }}
          >
            PPE
          </h2>
          {ppeQuery.isLoading ? (
            <p>Loading PPE…</p>
          ) : (ppeQuery.data ?? []).length === 0 ? (
            <p>No PPE issued.</p>
          ) : (
            <ul>
              {(ppeQuery.data ?? []).map((item) => (
                <li key={item.ppeItemId}>
                  {item.itemType} · size {item.size} · expires {item.nfpaExpiryDate} ·{' '}
                  <strong
                    style={
                      item.status === 'EXPIRED' ? { color: 'var(--boxalarm-error)' } : undefined
                    }
                  >
                    {item.status === 'EXPIRED' ? 'EXPIRED' : item.status}
                  </strong>
                </li>
              ))}
            </ul>
          )}

          {canIssuePpe ? (
            <form
              aria-label="Issue PPE"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                issuePpeMutation.mutate(ppeForm);
              }}
              style={{
                marginTop: 'var(--boxalarm-spacing-lg)',
                display: 'grid',
                gap: 'var(--boxalarm-spacing-md)',
                maxWidth: 480,
              }}
            >
              <label style={{ display: 'grid', gap: 4 }}>
                Item type
                <input
                  value={ppeForm.itemType}
                  required
                  onChange={(e) => setPpeForm((prev) => ({ ...prev, itemType: e.target.value }))}
                  style={{ minHeight: 44, padding: '0 12px' }}
                />
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                Size
                <input
                  value={ppeForm.size}
                  required
                  onChange={(e) => setPpeForm((prev) => ({ ...prev, size: e.target.value }))}
                  style={{ minHeight: 44, padding: '0 12px' }}
                />
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                Issue date
                <input
                  type="date"
                  value={ppeForm.issueDate}
                  required
                  onChange={(e) => setPpeForm((prev) => ({ ...prev, issueDate: e.target.value }))}
                  style={{ minHeight: 44, padding: '0 12px' }}
                />
              </label>
              {ppeFormError ? (
                <p role="alert" aria-live="assertive">
                  {ppeFormError}
                </p>
              ) : null}
              <button type="submit" style={{ minHeight: 44 }}>
                Issue PPE
              </button>
            </form>
          ) : null}
        </>
      )}
    </main>
  );
}
