import { useDemoRole } from '../auth/AuthContext';
import { KNOWN_ROLES, type Role } from '../auth/roles';

export function DemoBanner() {
  const { role, setRole } = useDemoRole();

  return (
    <div
      role="status"
      style={{
        background: 'var(--boxalarm-warning)',
        color: 'var(--boxalarm-bg)',
        padding: 'var(--boxalarm-spacing-sm) var(--boxalarm-spacing-md)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--boxalarm-spacing-md)',
        alignItems: 'center',
      }}
    >
      <strong>Demo — sample data</strong>
      <label>
        Viewing as{' '}
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {KNOWN_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
