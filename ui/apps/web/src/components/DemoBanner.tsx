import { useDemoRole } from '../auth/AuthContext';
import { KNOWN_ROLES, type Role } from '../auth/roles';
import styles from './DemoBanner.module.css';

export function DemoBanner() {
  const { role, setRole } = useDemoRole();

  return (
    <div role="status" className={styles.banner}>
      <strong>Demo — sample data</strong>
      <label>
        Viewing as{' '}
        <select
          className={styles.select}
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
        >
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
