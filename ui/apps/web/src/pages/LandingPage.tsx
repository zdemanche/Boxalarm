import { useQuery } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { spacing, typography } from '@boxalarm/design-tokens';
import { useAuth, type Role } from '../auth/AuthContext';
import { canAccessPath, firstGrantedNavPath } from '../routing/routeTable';
import { listApparatus } from '../features/apparatus/api';
import { listMembers } from '../features/personnel/api';
import { Card, Stat } from '../components/ui/Card';
import styles from './LandingPage.module.css';

const ROLE_PRIORITY: readonly Role[] = [
  'CHIEF',
  'ADMIN',
  'OFFICER',
  'TRAINING',
  'APPARATUS',
  'MEMBER',
];

const ROLE_LABEL: Record<Role, string> = {
  CHIEF: 'Chief dashboard',
  ADMIN: 'Admin dashboard',
  OFFICER: 'Officer dashboard',
  TRAINING: 'Training dashboard',
  APPARATUS: 'Apparatus dashboard',
  MEMBER: 'Member home',
};

// Command-console dashboards are shown for roles that manage the department; a plain member's
// home stays a simple summary (design.draft.md §4.4 — member read-only scope).
const DASHBOARD_ROLES: readonly Role[] = ['CHIEF', 'ADMIN', 'OFFICER', 'APPARATUS'];

function primaryRole(roles: Role[]): Role {
  return ROLE_PRIORITY.find((role) => roles.includes(role)) ?? 'MEMBER';
}

function CommandConsole() {
  const auth = useAuth();
  const apparatusQuery = useQuery({ queryKey: ['apparatus'], queryFn: () => listApparatus(auth) });
  const membersQuery = useQuery({
    queryKey: ['personnel', 'members'],
    queryFn: () => listMembers(auth),
  });

  const apparatus = apparatusQuery.data ?? [];
  const inService = apparatus.filter((a) => a.status === 'IN_SERVICE').length;
  const outOfService = apparatus.filter((a) => a.status === 'OUT_OF_SERVICE').length;
  const members = membersQuery.data ?? [];
  const activeMembers = members.filter((m) => m.status === 'ACTIVE').length;

  return (
    <>
      {/* MAJOR-2 (PR #318 review): this used to hardcode "No active call." with a green
          checkmark in a role="status" live region, stated as fact regardless of whether a call
          was actually active — a false operational claim on the CHIEF/OFFICER dashboard of a
          life-safety dispatch app. There is no incidents/dispatch feature in this app yet to
          wire a real answer to, so this is an honest "not wired" placeholder (matching the
          shift/certification cards below) instead of a fabricated status. */}
      <div className={styles.callBanner}>
        Active-call status isn&rsquo;t wired to this dashboard yet.
      </div>

      <div className={styles.statGrid}>
        <Stat
          label="Apparatus in service"
          value={apparatusQuery.isLoading ? '—' : `${inService} / ${apparatus.length}`}
        />
        <Stat
          label="Out of service"
          value={apparatusQuery.isLoading ? '—' : outOfService}
          alarm={outOfService > 0}
        />
        <Stat
          label="Active members"
          value={membersQuery.isLoading ? '—' : `${activeMembers} / ${members.length}`}
        />
        <Stat label="Expiring certifications" value="—" hint="Not yet wired to this screen" />
      </div>

      <div className={styles.sectionGrid}>
        <Card title="Today's shifts">Shift coverage isn't wired to this dashboard yet.</Card>
        <Card title="Expiring certifications">
          Certification tracking isn't wired to this dashboard yet.
        </Card>
      </div>
    </>
  );
}

export function LandingPage() {
  const { roles } = useAuth();
  const role = primaryRole(roles);

  if (!canAccessPath('/', roles)) {
    const fallback = firstGrantedNavPath(roles);
    if (fallback) return <Navigate to={fallback} replace />;
  }

  return (
    <main id="main-content" style={{ padding: spacing.lg }}>
      <h1 style={{ fontSize: typography.size.xl, margin: 0 }}>{ROLE_LABEL[role]}</h1>
      {DASHBOARD_ROLES.includes(role) ? <CommandConsole /> : null}
    </main>
  );
}
