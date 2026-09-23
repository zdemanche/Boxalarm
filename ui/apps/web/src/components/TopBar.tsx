import { useAuth } from '../auth/AuthContext';
import { usePalette } from '../lib/usePalette';
import { IconButton } from './ui/Button';
import { CheckCircle2, Moon, Sun } from './ui/icons';
import styles from './AppShell.module.css';

const ROLE_LABEL: Record<string, string> = {
  MEMBER: 'Member',
  OFFICER: 'Officer',
  TRAINING: 'Training officer',
  APPARATUS: 'Apparatus officer',
  ADMIN: 'Administrator',
  CHIEF: 'Chief',
};

export function TopBar() {
  const { roles } = useAuth();
  const [palette, setPalette] = usePalette();
  const isCab = palette === 'cab';
  const primaryRole = roles[0];

  return (
    <header className={styles.topbar} role="banner">
      <div className={styles.topbarLeft} role="status">
        <CheckCircle2 size={15} aria-hidden="true" />
        <span>Connected</span>
      </div>
      <div className={styles.topbarRight}>
        {primaryRole ? (
          <span className={styles.roleLabel}>{ROLE_LABEL[primaryRole] ?? primaryRole}</span>
        ) : null}
        <IconButton
          icon={isCab ? Sun : Moon}
          label={isCab ? 'Switch to day palette' : 'Switch to cab palette'}
          onClick={() => setPalette(isCab ? 'day' : 'cab')}
          size="sm"
        />
      </div>
    </header>
  );
}
