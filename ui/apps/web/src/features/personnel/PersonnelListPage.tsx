import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { createMember, listMembers } from './api';
import type { CreateMemberInput } from './types';

const emptyForm: CreateMemberInput = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  joinDate: '',
  rank: '',
  agencyId: '',
};

export function PersonnelListPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = auth.roles.includes('ADMIN');
  const [form, setForm] = useState<CreateMemberInput>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  const membersQuery = useQuery({
    queryKey: ['personnel', 'members'],
    queryFn: () => listMembers(auth),
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateMemberInput) => createMember(auth, input),
    onSuccess: async () => {
      setForm(emptyForm);
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ['personnel', 'members'] });
    },
    onError: (error: Error) => {
      setFormError(error.message);
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    createMutation.mutate(form);
  };

  if (membersQuery.error) {
    return (
      <ApiForbiddenGate error={membersQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  return (
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>Personnel</h1>

      {membersQuery.isLoading ? (
        <p>Loading roster…</p>
      ) : (
        <table
          style={{
            width: '100%',
            marginTop: 'var(--boxalarm-spacing-lg)',
            borderCollapse: 'collapse',
          }}
        >
          <thead>
            <tr>
              <th scope="col" style={{ textAlign: 'left' }}>
                Name
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Contact
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Status
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Join date
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Rank
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Agency ID
              </th>
            </tr>
          </thead>
          <tbody>
            {(membersQuery.data ?? []).map((member) => (
              <tr key={member.memberId}>
                <th scope="row" style={{ textAlign: 'left', fontWeight: 500 }}>
                  <Link to={`/personnel/${member.memberId}`}>
                    {member.lastName}, {member.firstName}
                  </Link>
                </th>
                <td>
                  {member.email}
                  <br />
                  {member.phone}
                </td>
                <td>{member.status}</td>
                <td>{member.joinDate}</td>
                <td>{member.rank}</td>
                <td>{member.agencyId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {isAdmin ? (
        <form
          onSubmit={onSubmit}
          aria-label="Create member"
          style={{
            marginTop: 'var(--boxalarm-spacing-xl)',
            display: 'grid',
            gap: 'var(--boxalarm-spacing-md)',
            maxWidth: 480,
          }}
        >
          <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>Add member</h2>
          {(
            [
              ['firstName', 'First name'],
              ['lastName', 'Last name'],
              ['email', 'Email'],
              ['phone', 'Phone'],
              ['joinDate', 'Join date'],
              ['rank', 'Rank'],
              ['agencyId', 'Agency ID'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} style={{ display: 'grid', gap: 4 }}>
              {label}
              <input
                name={key}
                value={form[key]}
                onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                required
                style={{ minHeight: 44, padding: '0 12px' }}
              />
            </label>
          ))}
          {formError ? (
            <p role="alert" aria-live="assertive">
              {formError}
            </p>
          ) : null}
          <button type="submit" style={{ minHeight: 44 }}>
            Create member
          </button>
        </form>
      ) : null}
    </main>
  );
}
