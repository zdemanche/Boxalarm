import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Badge } from '../../components/ui/Chip';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { DataTable, type DataTableColumn } from '../../components/ui/DataTable';
import { TextInput } from '../../components/ui/Field';
import { PageHeader } from '../../components/ui/PageHeader';
import { createMember, listMembers } from './api';
import type { CreateMemberInput, Member } from './types';

const emptyForm: CreateMemberInput = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  joinDate: '',
  rank: '',
  agencyId: '',
};

const FORM_FIELDS: Array<[keyof CreateMemberInput, string]> = [
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['joinDate', 'Join date'],
  ['rank', 'Rank'],
  ['agencyId', 'Agency ID'],
];

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

  const columns: DataTableColumn<Member>[] = [
    {
      key: 'name',
      header: 'Name',
      isRowHeader: true,
      sortValue: (m) => `${m.lastName}, ${m.firstName}`,
      render: (m) => (
        <Link to={`/personnel/${m.memberId}`} style={{ fontWeight: 600 }}>
          {m.lastName}, {m.firstName}
        </Link>
      ),
    },
    {
      key: 'contact',
      header: 'Contact',
      render: (m) => (
        <span>
          {m.email}
          <br />
          {m.phone}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (m) => m.status,
      render: (m) => <Badge>{m.status}</Badge>,
    },
    {
      key: 'joinDate',
      header: 'Join date',
      sortValue: (m) => m.joinDate,
      render: (m) => m.joinDate,
    },
    { key: 'rank', header: 'Rank', sortValue: (m) => m.rank, render: (m) => m.rank },
    { key: 'agencyId', header: 'Agency ID', render: (m) => m.agencyId },
  ];

  return (
    <main id="main-content">
      <PageHeader title="Personnel" />

      <DataTable
        caption="Member roster"
        rowKey={(m) => m.memberId}
        columns={columns}
        rows={membersQuery.data ?? []}
        loading={membersQuery.isLoading}
        emptyMessage="No members yet."
      />

      {isAdmin ? (
        <Card title="Add member" style={{ marginTop: 'var(--bx-space-lg)', maxWidth: 480 }}>
          <form
            onSubmit={onSubmit}
            aria-label="Create member"
            style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
          >
            {FORM_FIELDS.map(([key, label]) => (
              <TextInput
                key={key}
                label={label}
                value={form[key]}
                onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                required
              />
            ))}
            {formError ? (
              <p role="alert" aria-live="assertive" style={{ color: 'var(--bx-status-danger)' }}>
                {formError}
              </p>
            ) : null}
            <Button type="submit" loading={createMutation.isPending}>
              Create member
            </Button>
          </form>
        </Card>
      ) : null}
    </main>
  );
}
