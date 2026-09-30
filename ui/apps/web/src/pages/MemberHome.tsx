import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Button, Card, Skeleton, StatusChip } from '../components/ui';
import { listApparatus } from '../features/apparatus/api';
import { getMemberLosap } from '../features/personnel/api';
import { listShifts } from '../features/schedule/api';
import { SHIFT_STATUS_LABEL } from '../features/schedule/types';
import { formatShiftWindow } from '../features/schedule/format';
import { listCertifications } from '../features/training/api';
import type { Certification } from '../features/training/types';
import { useStations } from '../lib/useStations';
import styles from './LandingPage.module.css';

const DAY_MS = 24 * 60 * 60 * 1000;
const SHIFT_HORIZON_DAYS = 7;
const CERT_WARNING_DAYS = 60;

function Unavailable({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className={styles.tileError}>
      <p className={styles.tileMessage}>Couldn&rsquo;t load {what}. This is not an empty result.</p>
      <Button size="md" variant="secondary" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function daysUntil(isoDate: string, now: number): number {
  return Math.ceil((new Date(`${isoDate}T00:00:00`).getTime() - now) / DAY_MS);
}

function CertLine({ cert, now }: { cert: Certification; now: number }) {
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
    <li className={styles.listItem}>
      <strong>{cert.certType}</strong> <StatusChip status={role}>{word}</StatusChip>
      <span className={styles.meta}> · expires {cert.expiryDate}</span>
    </li>
  );
}

/**
 * docs/design.md O-02 no-permission row: a member signed into the web gets their own summary -
 * how to mark off, the next shifts, their certifications and points, and what's out of service -
 * not a blank page with a heading. Every section reads an endpoint open to every role.
 */
export function MemberHome() {
  const auth = useAuth();
  const memberId = auth.memberId;
  const { nameFor } = useStations();
  const now = Date.now();

  const shiftsQuery = useQuery({
    queryKey: ['schedule', 'shifts'],
    queryFn: () => listShifts(auth),
  });
  const certsQuery = useQuery({
    queryKey: ['training', 'certifications', memberId],
    queryFn: () => listCertifications(auth, memberId ?? ''),
    enabled: memberId !== null,
  });
  const losapQuery = useQuery({
    queryKey: ['personnel', 'losap', memberId],
    queryFn: () => getMemberLosap(auth, memberId ?? ''),
    enabled: memberId !== null,
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
  const certs = [...(certsQuery.data ?? [])].sort((a, b) =>
    a.expiryDate.localeCompare(b.expiryDate),
  );
  const outOfService = (apparatusQuery.data ?? []).filter((a) => a.status === 'OUT_OF_SERVICE');

  return (
    <>
      <p className={styles.tileMessage}>
        This is your summary. Department-wide figures are visible to the chief, administrator, and
        training officer.
      </p>
      <div className={styles.sectionGrid}>
        <Card title="Your availability">
          <p className={styles.tileMessage}>
            Can&rsquo;t respond for a while? Mark yourself unavailable so you aren&rsquo;t alerted
            for calls and the officer knows not to expect you.
          </p>
          <Link to="/availability" className={styles.actionLink}>
            Mark unavailable
          </Link>
        </Card>

        <Card title={`Shifts in the next ${SHIFT_HORIZON_DAYS} days`}>
          {shiftsQuery.isLoading ? (
            <Skeleton lines={2} />
          ) : shiftsQuery.error ? (
            <Unavailable what="shifts" onRetry={() => void shiftsQuery.refetch()} />
          ) : upcoming.length === 0 ? (
            <p className={styles.tileMessage}>
              No shifts scheduled this week. Officers post shifts as they&rsquo;re scheduled.
            </p>
          ) : (
            <ul className={styles.list}>
              {upcoming.map((shift) => (
                <li key={shift.shiftId} className={styles.listItem}>
                  <strong>{nameFor(shift.stationId)}</strong>{' '}
                  {formatShiftWindow(shift.startAt, shift.endAt)}
                  <span className={styles.meta}> · {SHIFT_STATUS_LABEL[shift.status]}</span>
                </li>
              ))}
            </ul>
          )}
          <p className={styles.tileMessage}>Claim shifts in the Boxalarm app.</p>
        </Card>

        <Card title="Your certifications">
          {memberId === null || certsQuery.isLoading ? (
            <Skeleton lines={2} />
          ) : certsQuery.error ? (
            <Unavailable what="your certifications" onRetry={() => void certsQuery.refetch()} />
          ) : certs.length === 0 ? (
            <p className={styles.tileMessage}>
              No certifications on file. The training officer files certifications for you.
            </p>
          ) : (
            <ul className={styles.list}>
              {certs.map((cert) => (
                <CertLine key={cert.certId} cert={cert} now={now} />
              ))}
            </ul>
          )}
        </Card>

        <Card title="LOSAP points">
          {memberId === null || losapQuery.isLoading ? (
            <Skeleton lines={1} />
          ) : losapQuery.error || !losapQuery.data ? (
            <Unavailable what="your points" onRetry={() => void losapQuery.refetch()} />
          ) : (
            <p className={styles.bigNumber}>
              {losapQuery.data.totalPoints}{' '}
              <span className={styles.meta}>points in {losapQuery.data.year}</span>
            </p>
          )}
        </Card>

        <Card title="Out of service">
          {apparatusQuery.isLoading ? (
            <Skeleton lines={1} />
          ) : apparatusQuery.error ? (
            <Unavailable what="apparatus status" onRetry={() => void apparatusQuery.refetch()} />
          ) : outOfService.length === 0 ? (
            <p className={styles.tileMessage}>Nothing is out of service.</p>
          ) : (
            <ul className={styles.list}>
              {outOfService.map((unit) => (
                <li key={unit.apparatusId} className={styles.listItem}>
                  <StatusChip status="danger">Out of service</StatusChip>{' '}
                  <strong className={styles.mono}>{unit.unitId}</strong>
                  {unit.outOfService?.reason ? (
                    <span className={styles.meta}> · {unit.outOfService.reason}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
