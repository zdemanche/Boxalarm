import { FormEvent, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  Button,
  Card,
  DataTable,
  PageHeader,
  Stat,
  StatusChip,
  TextInput,
  type DataTableColumn,
} from '../../components/ui';
import { CalendarX, Clock, LogOut, Plus, Users } from '../../components/ui/icons';
import { createMember, listMembers } from './api';
import { MEMBER_STATUS_ROLE } from './memberStatus';
import type { CreateMemberInput, Member, MemberStatus } from './types';
import { formatCalendarDate } from '../../lib/dates';
import { humanize } from '../../lib/labels';
import styles from './PersonnelListPage.module.css';

const emptyForm: CreateMemberInput = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  joinDate: '',
  rank: '',
  agencyId: '',
};

const FORM_FIELDS: Array<[keyof CreateMemberInput, string, string]> = [
  ['firstName', 'First name', 'text'],
  ['lastName', 'Last name', 'text'],
  ['email', 'Email', 'email'],
  ['phone', 'Phone', 'tel'],
  ['joinDate', 'Join date', 'date'],
  ['rank', 'Rank', 'text'],
  ['agencyId', 'Agency ID', 'text'],
];

export function PersonnelListPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = auth.roles.includes('ADMIN');
  const [form, setForm] = useState<CreateMemberInput>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

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

  const members = membersQuery.data ?? [];
  const count = (status: MemberStatus) =>
    membersQuery.isLoading ? '—' : members.filter((m) => m.status === status).length;

  const columns: DataTableColumn<Member>[] = [
    {
      key: 'name',
      header: 'Name',
      isRowHeader: true,
      sortValue: (m) => `${m.lastName}, ${m.firstName}`,
      render: (m) => (
        <Link to={`/personnel/${m.memberId}`} className={styles.name}>
          {m.lastName}, {m.firstName}
        </Link>
      ),
    },
    {
      key: 'contact',
      header: 'Contact',
      render: (m) => (
        <span className={styles.contact}>
          <span>{m.email}</span>
          <span className={styles.phone}>{m.phone ?? 'No phone'}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (m) => m.status,
      render: (m) => (
        <StatusChip status={MEMBER_STATUS_ROLE[m.status]}>{humanize(m.status)}</StatusChip>
      ),
    },
    {
      key: 'joinDate',
      header: 'Join date',
      // ISO sorts chronologically; the cell reads "Apr 12, 2018".
      sortValue: (m) => m.joinDate,
      render: (m) => formatCalendarDate(m.joinDate),
    },
    { key: 'rank', header: 'Rank', sortValue: (m) => m.rank, render: (m) => m.rank },
    {
      key: 'agencyId',
      header: 'Agency ID',
      sortValue: (m) => m.agencyId,
      render: (m) => <span className={styles.mono}>{m.agencyId}</span>,
    },
  ];

  return (
    <main id="main-content">
      <PageHeader
        title="Members"
        description="Everyone on the department roster, with their status, rank and contact details."
        actions={
          isAdmin ? (
            // The form sits under a long roster; this takes the admin straight to its first field.
            <Button onClick={() => firstFieldRef.current?.focus()}>
              <Plus size={16} aria-hidden="true" />
              Add member
            </Button>
          ) : undefined
        }
      />

      <div className={styles.stats}>
        <Stat label="Active members" value={count('ACTIVE')} icon={Users} />
        <Stat label="On probation" value={count('PROBATIONARY')} icon={Clock} />
        <Stat label="On leave" value={count('LOA')} icon={CalendarX} />
        <Stat label="Retired" value={count('RETIRED')} icon={LogOut} />
      </div>

      <DataTable
        caption="Member roster"
        rowKey={(m) => m.memberId}
        columns={columns}
        rows={members}
        loading={membersQuery.isLoading}
        emptyMessage="No members yet."
      />

      {isAdmin ? (
        <Card title="Add member">
          <form onSubmit={onSubmit} aria-label="Create member">
            <div className={styles.formGrid}>
              {FORM_FIELDS.map(([key, label, type], index) => (
                <TextInput
                  key={key}
                  ref={index === 0 ? firstFieldRef : undefined}
                  label={label}
                  type={type}
                  value={form[key]}
                  onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                  required
                />
              ))}
            </div>
            <div className={styles.formActions}>
              {formError ? (
                <p role="alert" aria-live="assertive" className={styles.error}>
                  {formError}
                </p>
              ) : null}
              <Button type="submit" variant="secondary" loading={createMutation.isPending}>
                Create member
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
    </main>
  );
}
