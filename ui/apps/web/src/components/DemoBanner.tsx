import { useDemoRole } from '../auth/AuthContext';
import { KNOWN_ROLES, type Role } from '../auth/roles';
import styles from './DemoBanner.module.css';

const ROLE_LABEL: Record<Role, string> = {
  CHIEF: 'Chief',
  OFFICER: 'Officer',
  ADMIN: 'Admin',
  TRAINING: 'Training officer',
  APPARATUS: 'Apparatus officer',
  MEMBER: 'Member',
};

export function DemoBanner() {
  const { role, setRole } = useDemoRole();

  return (
    <div role="status" className={styles.banner}>
      <span className={styles.tag}>Demo</span>
      <span>Sample data — nothing here is real</span>
      <label className={styles.label}>
        Viewing as
        <select
          className={styles.select}
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
        >
          {KNOWN_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
