import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  getMember,
  getMemberLosap,
  getQuals,
  listOwnAttendance,
  putQual,
  recordAttendance,
  updateMemberStatus,
} from './api';
import type { AttendanceActivityType, MemberStatus } from './types';

const STATUSES: MemberStatus[] = ['PROBATIONARY', 'ACTIVE', 'LOA', 'RETIRED'];
const ACTIVITY_TYPES: AttendanceActivityType[] = [
  'CALL',
  'DRILL',
  'MEETING',
  'WORK_DETAIL',
  'STANDBY',
];

function QualsSection({ memberId, canEdit }: { memberId: string; canEdit: boolean }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [qualCode, setQualCode] = useState('');

  const qualsQuery = useQuery({
    queryKey: ['personnel', 'members', memberId, 'quals'],
    queryFn: () => getQuals(auth, memberId),
  });

  const addQual = useMutation({
    mutationFn: () => putQual(auth, memberId, qualCode, null),
    onSuccess: async () => {
      setQualCode('');
      await queryClient.invalidateQueries({
        queryKey: ['personnel', 'members', memberId, 'quals'],
      });
    },
  });

  return (
    <section style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
      <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>Qualifications</h2>
      {qualsQuery.isLoading ? (
        <p>Loading qualifications…</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {(qualsQuery.data ?? []).map((qual) => (
            <li key={qual.qualCode} style={{ padding: 'var(--boxalarm-spacing-xs) 0' }}>
              <strong>{qual.qualCode}</strong> —{' '}
              {qual.currentlyEligible ? 'Eligible' : 'Not currently eligible'}
              {qual.grantedByCertId ? (
                <>
                  {' '}
                  (<Link to={`/certifications`}>cert {qual.grantedByCertId}</Link>)
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <form
          aria-label="Assign qualification"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            addQual.mutate();
          }}
          style={{ display: 'flex', gap: 'var(--boxalarm-spacing-sm)', alignItems: 'end' }}
        >
          <label style={{ display: 'grid', gap: 4 }}>
            Qual code
            <input
              value={qualCode}
              onChange={(e) => setQualCode(e.target.value)}
              required
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <button type="submit" style={{ minHeight: 44 }}>
            Assign
          </button>
        </form>
      ) : null}
    </section>
  );
}

function LosapSection({ memberId }: { memberId: string }) {
  const auth = useAuth();
  const losapQuery = useQuery({
    queryKey: ['personnel', 'members', memberId, 'losap'],
    queryFn: () => getMemberLosap(auth, memberId),
  });

  return (
    <section style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
      <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>LOSAP</h2>
      {losapQuery.isLoading ? (
        <p>Loading LOSAP total…</p>
      ) : losapQuery.error ? (
        <ApiForbiddenGate error={losapQuery.error} embedded>
          <p>Unable to load LOSAP total.</p>
        </ApiForbiddenGate>
      ) : (
        <p>
          {losapQuery.data?.totalPoints} points in {losapQuery.data?.year}
        </p>
      )}
    </section>
  );
}

function AttendanceSection({ memberId, isOwnRecord }: { memberId: string; isOwnRecord: boolean }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<{ activityType: AttendanceActivityType; hours: string }>({
    activityType: 'DRILL',
    hours: '',
  });

  const attendanceQuery = useQuery({
    queryKey: ['personnel', 'attendance', memberId],
    queryFn: () => listOwnAttendance(auth),
    enabled: isOwnRecord,
  });

  const addEntry = useMutation({
    mutationFn: () =>
      recordAttendance(auth, {
        activityType: form.activityType,
        refId: null,
        occurredAt: Math.floor(Date.now() / 1000),
        hours: Number(form.hours),
      }),
    onSuccess: async () => {
      setForm({ activityType: 'DRILL', hours: '' });
      await queryClient.invalidateQueries({ queryKey: ['personnel', 'attendance', memberId] });
    },
  });

  if (!isOwnRecord) {
    return null;
  }

  return (
    <section style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
      <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>Attendance</h2>
      {attendanceQuery.isLoading ? (
        <p>Loading attendance…</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {(attendanceQuery.data ?? [])
            .slice()
            .sort((a, b) => a.occurredAt - b.occurredAt)
            .map((record) => (
              <li key={`${record.activityType}-${record.occurredAt}`}>
                {record.activityType} — {new Date(record.occurredAt * 1000).toLocaleDateString()}
                {record.refId ? ` — dispatch ${record.refId}` : ''} — {record.hours}h
              </li>
            ))}
        </ul>
      )}
      <form
        aria-label="Record attendance"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          addEntry.mutate();
        }}
        style={{ display: 'flex', gap: 'var(--boxalarm-spacing-sm)', alignItems: 'end' }}
      >
        <label style={{ display: 'grid', gap: 4 }}>
          Activity
          <select
            value={form.activityType}
            onChange={(e) =>
              setForm((prev) => ({
                ...prev,
                activityType: e.target.value as AttendanceActivityType,
              }))
            }
            style={{ minHeight: 44 }}
          >
            {ACTIVITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          Hours
          <input
            type="number"
            min="0"
            step="0.25"
            value={form.hours}
            onChange={(e) => setForm((prev) => ({ ...prev, hours: e.target.value }))}
            required
            style={{ minHeight: 44, padding: '0 12px', width: 100 }}
          />
        </label>
        <button type="submit" style={{ minHeight: 44 }}>
          Record
        </button>
      </form>
    </section>
  );
}

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

          <QualsSection memberId={id} canEdit={isAdmin} />
          <LosapSection memberId={id} />
          <AttendanceSection memberId={id} isOwnRecord={id === auth.user?.profile.sub} />
        </>
      )}
    </main>
  );
}
