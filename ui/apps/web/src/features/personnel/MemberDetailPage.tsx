import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StatusRole } from '@boxalarm/design-tokens';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import {
  canManageInventory,
  canManageMemberAvailability,
  canManageTraining,
} from '../../auth/roles';
import { MarkOffList } from '../availability/MarkOffList';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { AuditHistoryLink } from '../../components/AuditHistoryLink';
import {
  Button,
  Card,
  DatePicker,
  PageHeader,
  Select,
  Skeleton,
  StatusChip,
  TextInput,
} from '../../components/ui';
import { CertificationsPanel } from '../training/CertificationsPanel';
import { TranscriptPanel } from '../training/TranscriptPanel';
import { issueMemberPpe, listMemberPpe } from '../inventory/api';
import type { IssuePpeInput, PpeStatus } from '../inventory/types';
import {
  getMember,
  getMemberLosap,
  getQuals,
  listOwnAttendance,
  putQual,
  recordAttendance,
} from './api';
import type { AttendanceActivityType, Member } from './types';
import { RolesSection } from './RolesSection';
import { AccountSecuritySection, canUseAccountKillSwitches } from './AccountSecuritySection';
import { MemberStatusSection } from './MemberStatusSection';
import { MEMBER_STATUS_ROLE } from './memberStatus';
import { formatCalendarDate } from '../../lib/dates';
import { humanize } from '../../lib/labels';
import styles from './MemberDetailPage.module.css';

const ACTIVITY_TYPES: AttendanceActivityType[] = [
  'CALL',
  'DRILL',
  'MEETING',
  'WORK_DETAIL',
  'STANDBY',
];
const today = () => new Date().toISOString().slice(0, 10);
const emptyPpeForm: IssuePpeInput = { itemType: '', size: '', issueDate: today() };

const PPE_STATUS_ROLE: Record<PpeStatus, StatusRole> = {
  ISSUED: 'ok',
  EXPIRED: 'danger',
  RETIRED: 'neutral',
};

function ProfileCard({ member }: { member: Member }) {
  return (
    <Card title="Profile">
      <dl className={styles.facts}>
        <dt>Status</dt>
        <dd>
          <StatusChip status={MEMBER_STATUS_ROLE[member.status]}>
            {humanize(member.status)}
          </StatusChip>
        </dd>
        <dt>Email</dt>
        <dd>{member.email}</dd>
        <dt>Phone</dt>
        <dd className={member.phone ? styles.mono : undefined}>
          {member.phone ?? 'No phone (no SMS or voice pages)'}
        </dd>
        <dt>Rank</dt>
        <dd>{member.rank}</dd>
        <dt>Agency ID</dt>
        <dd className={styles.mono}>{member.agencyId}</dd>
        <dt>Joined</dt>
        <dd>{formatCalendarDate(member.joinDate)}</dd>
      </dl>
    </Card>
  );
}

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

  const quals = qualsQuery.data ?? [];

  return (
    <Card title="Qualifications">
      {qualsQuery.isLoading ? (
        <Skeleton lines={2} />
      ) : quals.length === 0 ? (
        <p className={styles.muted}>No qualifications on file.</p>
      ) : (
        <ul className={styles.list}>
          {quals.map((qual) => (
            <li key={qual.qualCode} className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{humanize(qual.qualCode)}</span>
                {qual.grantedByCertId ? (
                  <span className={styles.rowMeta}>
                    Granted by <Link to={`/certifications`}>cert {qual.grantedByCertId}</Link>
                  </span>
                ) : null}
              </span>
              <StatusChip status={qual.currentlyEligible ? 'ok' : 'caution'}>
                {qual.currentlyEligible ? 'Eligible' : 'Not currently eligible'}
              </StatusChip>
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
          className={[styles.inlineForm, styles.subsection].join(' ')}
        >
          <TextInput
            label="Qual code"
            value={qualCode}
            onChange={(e) => setQualCode(e.target.value)}
            required
          />
          <Button type="submit" variant="secondary" loading={addQual.isPending}>
            Assign
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

function LosapSection({ memberId }: { memberId: string }) {
  const auth = useAuth();
  const losapQuery = useQuery({
    queryKey: ['personnel', 'members', memberId, 'losap'],
    queryFn: () => getMemberLosap(auth, memberId),
  });

  return (
    <Card title="LOSAP points">
      {losapQuery.isLoading ? (
        <Skeleton lines={1} />
      ) : losapQuery.error ? (
        <ApiForbiddenGate error={losapQuery.error} embedded>
          <p className={styles.muted}>Unable to load LOSAP total.</p>
        </ApiForbiddenGate>
      ) : (
        <p className={styles.figure}>
          <span className={styles.bigNumber}>{losapQuery.data?.totalPoints}</span>{' '}
          <span className={styles.muted}>points in {losapQuery.data?.year}</span>
        </p>
      )}
    </Card>
  );
}

function PpeSection({ memberId }: { memberId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  // IssuePpeAssignment is an INVENTORY_ADMIN_GROUPS action: OFFICER, CHIEF, ADMIN (review m6).
  const canIssuePpe = canManageInventory(auth.roles);
  const [ppeForm, setPpeForm] = useState<IssuePpeInput>(emptyPpeForm);
  const [ppeFormError, setPpeFormError] = useState<string | null>(null);

  const ppeQuery = useQuery({
    queryKey: ['inventory', 'ppe', memberId],
    queryFn: () => listMemberPpe(auth, memberId),
    enabled: Boolean(memberId),
  });

  const issuePpeMutation = useMutation({
    mutationFn: (input: IssuePpeInput) => issueMemberPpe(auth, memberId, input),
    onSuccess: async () => {
      setPpeForm(emptyPpeForm);
      setPpeFormError(null);
      await queryClient.invalidateQueries({ queryKey: ['inventory', 'ppe', memberId] });
    },
    onError: (error: Error) => setPpeFormError(error.message),
  });

  const items = ppeQuery.data ?? [];

  return (
    <Card title="PPE">
      {ppeQuery.isLoading ? (
        <Skeleton lines={3} />
      ) : items.length === 0 ? (
        <p className={styles.muted}>No PPE issued.</p>
      ) : (
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.ppeItemId} className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{humanize(item.itemType)}</span>
                <span className={styles.rowMeta}>
                  Size {item.size} · NFPA expiry {formatCalendarDate(item.nfpaExpiryDate)}
                </span>
              </span>
              <StatusChip status={PPE_STATUS_ROLE[item.status]}>{humanize(item.status)}</StatusChip>
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
          className={styles.subsection}
        >
          <h3 className={styles.subhead}>Issue PPE</h3>
          <div className={styles.formGrid}>
            <TextInput
              label="Item type"
              value={ppeForm.itemType}
              required
              onChange={(e) => setPpeForm((prev) => ({ ...prev, itemType: e.target.value }))}
            />
            <TextInput
              label="Size"
              value={ppeForm.size}
              required
              onChange={(e) => setPpeForm((prev) => ({ ...prev, size: e.target.value }))}
            />
            <DatePicker
              label="Issue date"
              value={ppeForm.issueDate}
              required
              onChange={(e) => setPpeForm((prev) => ({ ...prev, issueDate: e.target.value }))}
            />
          </div>
          <div className={styles.formActions}>
            {ppeFormError ? (
              <p role="alert" aria-live="assertive" className={styles.error}>
                {ppeFormError}
              </p>
            ) : null}
            <Button type="submit" variant="secondary" loading={issuePpeMutation.isPending}>
              Issue PPE
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
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

  const records = (attendanceQuery.data ?? []).slice().sort((a, b) => a.occurredAt - b.occurredAt);

  return (
    <Card title="Attendance">
      {attendanceQuery.isLoading ? (
        <Skeleton lines={3} />
      ) : records.length === 0 ? (
        <p className={styles.muted}>No attendance recorded yet.</p>
      ) : (
        <ul className={styles.list}>
          {records.map((record) => (
            <li key={`${record.activityType}-${record.occurredAt}`} className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{humanize(record.activityType)}</span>
                <span className={styles.rowMeta}>
                  {new Date(record.occurredAt * 1000).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                  {record.refId ? ` · dispatch ${record.refId}` : ''}
                </span>
              </span>
              <span className={styles.rowTitle}>{record.hours}h</span>
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
        className={[styles.inlineForm, styles.subsection].join(' ')}
      >
        <Select
          label="Activity"
          value={form.activityType}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              activityType: e.target.value as AttendanceActivityType,
            }))
          }
        >
          {ACTIVITY_TYPES.map((type) => (
            <option key={type} value={type}>
              {humanize(type)}
            </option>
          ))}
        </Select>
        <TextInput
          label="Hours"
          type="number"
          min="0"
          step="0.25"
          value={form.hours}
          onChange={(e) => setForm((prev) => ({ ...prev, hours: e.target.value }))}
          required
          style={{ width: 100 }}
        />
        <Button type="submit" variant="secondary" loading={addEntry.isPending}>
          Record
        </Button>
      </form>
    </Card>
  );
}

export function MemberDetailPage() {
  const { id = '' } = useParams();
  const auth = useAuth();
  const isAdmin = auth.roles.includes('ADMIN');
  // Role assignment is CHIEF/ADMIN only - not OFFICER, who could otherwise promote themselves.
  const canManageRoles = canUseAccountKillSwitches(auth.roles);
  const isTraining = canManageTraining(auth.roles);

  const memberQuery = useQuery({
    queryKey: ['personnel', 'members', id],
    queryFn: () => getMember(auth, id),
    enabled: Boolean(id),
  });

  if (memberQuery.error) {
    return (
      <ApiForbiddenGate error={memberQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const member = memberQuery.data;
  const name = member ? `${member.firstName} ${member.lastName}` : '…';

  return (
    <main id="main-content">
      <PageHeader
        title={name}
        description={member ? member.rank : undefined}
        breadcrumbs={[{ label: 'Members', to: '/personnel' }, { label: name }]}
        actions={
          member ? <AuditHistoryLink entityType="MEMBER" entityId={member.memberId} /> : undefined
        }
      />
      {memberQuery.isLoading || !member ? (
        <Card>
          <p className={styles.muted}>Loading member…</p>
          <Skeleton lines={4} />
        </Card>
      ) : (
        <div className={styles.layout}>
          <div className={styles.column}>
            <ProfileCard member={member} />
            <MemberStatusSection member={member} />
            <LosapSection memberId={id} />
            {canManageMemberAvailability(auth.roles) ? (
              <MarkOffList
                memberId={member.memberId}
                ownRecord={member.memberId === auth.user?.profile.sub}
              />
            ) : null}
            <RolesSection member={member} canEdit={canManageRoles} />
            <AccountSecuritySection member={member} />
          </div>
          <div className={styles.column}>
            <CertificationsPanel memberId={member.memberId} />
            <QualsSection memberId={id} canEdit={isAdmin} />
            <PpeSection memberId={id} />
            {isTraining ? <TranscriptPanel memberId={member.memberId} /> : null}
            <AttendanceSection memberId={id} isOwnRecord={id === auth.user?.profile.sub} />
          </div>
        </div>
      )}
    </main>
  );
}
