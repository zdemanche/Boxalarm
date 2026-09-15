import { spacing, typography } from '@boxalarm/design-tokens';
import { useAuth, type Role } from '../auth/AuthContext';

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
  MEMBER: 'Member dashboard',
};

function primaryRole(roles: Role[]): Role {
  return ROLE_PRIORITY.find((role) => roles.includes(role)) ?? 'MEMBER';
}

export function LandingPage() {
  const { roles } = useAuth();
  const role = primaryRole(roles);

  return (
    <main style={{ padding: spacing.lg }}>
      <h1 style={{ fontSize: typography.size.xl, margin: 0 }}>{ROLE_LABEL[role]}</h1>
    </main>
  );
}
