import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { StatusRole } from '@boxalarm/design-tokens';
import { useAuth } from '../auth/AuthContext';
import { Button, Card, Skeleton, StatusChip, buttonClassName } from '../components/ui';
import { listApparatus } from '../features/apparatus/api';
import { getMemberLosap } from '../features/personnel/api';
import { listShifts } from '../features/schedule/api';
import { SHIFT_STATUS_LABEL, type ShiftStatus } from '../features/schedule/types';
import { formatShiftWindow } from '../features/schedule/format';
import { listCertifications } from '../features/training/api';
import type { Certification } from '../features/training/types';
import { useStations } from '../lib/useStations';
import styles from './MemberHome.module.css';
import { formatCalendarDate } from '../lib/dates';

const DAY_MS = 24 * 60 * 60 * 1000;
const SHIFT_HORIZON_DAYS = 7;
const CERT_WARNING_DAYS = 60;

/** A shift's fill as a status: an open seat is what a member can act on. */
const SHIFT_STATUS_ROLE: Record<ShiftStatus, StatusRole> = {
  OPEN: 'warning',
  PARTIALLY_FILLED: 'caution',
  FULL: 'ok',
  CANCELLED: 'neutral',
};

function Unavailable({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className={styles.error}>
      <p className={styles.message}>Couldn&rsquo;t load {what}. This is not an empty result.</p>
      <Button size="md" variant="secondary" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function daysUntil(isoDate: string, now: number): number {
  return Math.ceil((new Date(`${isoDate}T00:00:00`).getTime() - now) / DAY_MS);
}

function CertRow({ cert, now }: { cert: Certification; now: number }) {
  const days = daysUntil(cert.expiryDate, now);
  const [role, word] =
    cert.status === 'REVOKED'
      ? (['neutral', 'Revoked'] as const)
      : days < 0
        ? (['danger', 'Expired'] as const)
        : days <= CERT_WARNING_DAYS
          ? (['warning', `Expires in ${days} ${days === 1 ? 'day' : 'days'}`] as const)
          : (['ok', 'Current'] as const);
  return (
    <li className={styles.row}>
      <span className={styles.rowBody}>
        <span className={styles.rowTitle}>{cert.certType}</span>
        <span className={styles.rowMeta}>
          {days < 0 ? 'Expired' : 'Expires'} {formatCalendarDate(cert.expiryDate)}
        </span>
      </span>
      <StatusChip status={role} className={styles.rowStatus}>
        {word}
      </StatusChip>
    </li>
  );
}

/** Mark off: the one thing a member most often comes to the web to do. `primary` on the member
 * home; a secondary action on a dashboard that already has its own primary. */
export function AvailabilityCard({ primary = false }: { primary?: boolean }) {
  return (
    <Card title="Your availability">
      <p className={styles.message}>
        Can&rsquo;t respond for a while? Mark yourself unavailable so you aren&rsquo;t alerted for
        calls and the officer knows not to expect you.
      </p>
      <div className={styles.action}>
        <Link
          to="/availability"
          className={buttonClassName({ variant: primary ? 'primary' : 'secondary' })}
        >
          Mark unavailable
        </Link>
      </div>
    </Card>
  );
}

export function OwnCertificationsCard() {
  const auth = useAuth();
  const memberId = auth.memberId;
  const now = Date.now();
  const certsQuery = useQuery({
    queryKey: ['training', 'certifications', memberId],
    queryFn: () => listCertifications(auth, memberId ?? ''),
    enabled: memberId !== null,
  });
  const certs = [...(certsQuery.data ?? [])].sort((a, b) =>
    a.expiryDate.localeCompare(b.expiryDate),
  );

  return (
    <Card title="Your certifications">
      {memberId === null || certsQuery.isLoading ? (
        <Skeleton lines={2} />
      ) : certsQuery.error ? (
        <Unavailable what="your certifications" onRetry={() => void certsQuery.refetch()} />
      ) : certs.length === 0 ? (
        <p className={styles.message}>
          No certifications on file. The training officer files certifications for you.
        </p>
      ) : (
        <ul className={styles.list}>
          {certs.map((cert) => (
            <CertRow key={cert.certId} cert={cert} now={now} />
          ))}
        </ul>
      )}
    </Card>
  );
}

export function LosapPointsCard() {
  const auth = useAuth();
  const memberId = auth.memberId;
  const losapQuery = useQuery({
    queryKey: ['personnel', 'losap', memberId],
    queryFn: () => getMemberLosap(auth, memberId ?? ''),
    enabled: memberId !== null,
  });

  return (
    <Card title="LOSAP points">
      {memberId === null || losapQuery.isLoading ? (
        <Skeleton lines={1} />
      ) : losapQuery.error || !losapQuery.data ? (
        <Unavailable what="your points" onRetry={() => void losapQuery.refetch()} />
      ) : (
        <p className={styles.points}>
          <span className={styles.pointsValue}>{losapQuery.data.totalPoints}</span>
          <span className={styles.pointsLabel}>points in {losapQuery.data.year}</span>
        </p>
      )}
    </Card>
  );
}

/**
 * The signed-in member's own record: mark off, their certifications, their LOSAP points. Shown on
 * every home, including the officer and chief dashboards (review m9) - a chief is a member too.
 * Every read is own-record (ViewCertifications, ViewOwnLosapTotal).
 */
export function OwnRecordCards() {
  return (
    <>
      <AvailabilityCard />
      <OwnCertificationsCard />
      <LosapPointsCard />
    </>
  );
}

/**
 * docs/design.md O-02 no-permission row: a member signed into the web gets their own summary -
 * how to mark off, the next shifts, their certifications and points, and what's out of service -
 * not a blank page with a heading. Every section reads an endpoint open to every role.
 */
export function MemberHome() {
  const auth = useAuth();
  const { nameFor } = useStations();
  const now = Date.now();

  const shiftsQuery = useQuery({
    queryKey: ['schedule', 'shifts'],
    queryFn: () => listShifts(auth),
  });
  const apparatusQuery = useQuery({ queryKey: ['apparatus'], queryFn: () => listApparatus(auth) });

  const upcoming = (shiftsQuery.data ?? [])
    .filter(
      (shift) =>
        shift.status !== 'CANCELLED' &&
        shift.endAt > now &&
        shift.startAt < now + SHIFT_HORIZON_DAYS * DAY_MS,
    )
    .sort((a, b) => a.startAt - b.startAt);
  const outOfService = (apparatusQuery.data ?? []).filter((a) => a.status === 'OUT_OF_SERVICE');

  return (
    <div className={styles.layout}>
      <div className={styles.column}>
        <Card title={`Shifts in the next ${SHIFT_HORIZON_DAYS} days`}>
          {shiftsQuery.isLoading ? (
            <Skeleton lines={2} />
          ) : shiftsQuery.error ? (
            <Unavailable what="shifts" onRetry={() => void shiftsQuery.refetch()} />
          ) : upcoming.length === 0 ? (
            <p className={styles.message}>
              No shifts scheduled this week. Officers post shifts as they&rsquo;re scheduled.
            </p>
          ) : (
            <ul className={styles.list}>
              {upcoming.map((shift) => (
                <li key={shift.shiftId} className={styles.row}>
                  <span className={styles.rowBody}>
                    <span className={styles.rowTitle}>{nameFor(shift.stationId)}</span>
                    <span className={styles.rowMeta}>
                      {formatShiftWindow(shift.startAt, shift.endAt)}
                    </span>
                  </span>
                  <StatusChip status={SHIFT_STATUS_ROLE[shift.status]} className={styles.rowStatus}>
                    {SHIFT_STATUS_LABEL[shift.status]}
                  </StatusChip>
                </li>
              ))}
            </ul>
          )}
          <p className={styles.footnote}>Claim shifts in the Boxalarm app.</p>
        </Card>
        <OwnCertificationsCard />
      </div>

      <div className={styles.column}>
        <AvailabilityCard primary />
        <LosapPointsCard />
        <Card title="Out of service">
          {apparatusQuery.isLoading ? (
            <Skeleton lines={1} />
          ) : apparatusQuery.error ? (
            <Unavailable what="apparatus status" onRetry={() => void apparatusQuery.refetch()} />
          ) : outOfService.length === 0 ? (
            <p className={styles.message}>Nothing is out of service.</p>
          ) : (
            <ul className={styles.list}>
              {outOfService.map((unit) => (
                <li key={unit.apparatusId} className={styles.row}>
                  <span className={styles.rowBody}>
                    <span className={[styles.rowTitle, styles.mono].join(' ')}>{unit.unitId}</span>
                    {unit.outOfService?.reason ? (
                      <span className={styles.rowMeta}>{unit.outOfService.reason}</span>
                    ) : null}
                  </span>
                  <StatusChip status="danger" className={styles.rowStatus}>
                    Out of service
                  </StatusChip>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="What you can see">
          <p className={styles.message}>
            This is your summary. Department-wide figures are visible to the chief, administrator,
            and training officer.
          </p>
        </Card>
      </div>
    </div>
  );
}
