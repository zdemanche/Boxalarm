import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { primaryRole as pickPrimaryRole } from '../auth/roles';
import { useOnlineStatus } from '../lib/useOnlineStatus';
import { usePalette } from '../lib/usePalette';
import { IconButton } from './ui/Button';
import { Menu, Moon, Sun, WifiOff } from './ui/icons';
import styles from './AppShell.module.css';

const ROLE_LABEL: Record<string, string> = {
  MEMBER: 'Member',
  OFFICER: 'Officer',
  TRAINING: 'Training officer',
  APPARATUS: 'Apparatus officer',
  ADMIN: 'Administrator',
  CHIEF: 'Chief',
};

interface TopBarProps {
  /** Opens NavDrawer — MAJOR-1 (PR #318 review): below `md` (767px) and at high browser zoom,
   * PrimaryNav's static sidebar is hidden and this button is the only way to reach navigation
   * and Sign out. Visible only below `md` (AppShell.module.css `.menuButton`). */
  onOpenNav: () => void;
  /** Right-side slot for the notification bell (AppShell passes NotificationBell, which needs
   * the query client and router that AppShell always has). */
  notifications?: ReactNode;
}

export function TopBar({ onOpenNav, notifications }: TopBarProps) {
  const { roles } = useAuth();
  const [palette, setPalette] = usePalette();
  const isCab = palette === 'cab';
  // Cognito group order is arbitrary; label with the highest-priority role (PR #321 m12).
  const primaryRole = roles.length > 0 ? pickPrimaryRole(roles) : undefined;
  // MAJOR-2 (PR #318 review): this used to be a hardcoded "Connected" string in this live
  // region, which is a false operational-status claim in a life-safety dispatch app - it never
  // reflected reality, including when the API was down or the browser was offline. This is the
  // only connectivity signal available in this app's current scope (no dispatch/API reachability
  // channel exists yet), so it is labelled for exactly what it measures rather than implied to
  // be a general "connected" status. Online is the normal case and shows nothing.
  const isOnline = useOnlineStatus();

  return (
    <header className={styles.topbar} role="banner">
      <div className={styles.topbarLeft}>
        <IconButton
          icon={Menu}
          label="Open navigation"
          onClick={onOpenNav}
          className={styles.menuButton}
        />
        {/* The live region is always mounted so going offline is announced; it is empty while
            online. It measures the browser's network only, not API or dispatch reachability,
            and says only what that means for the user's work. */}
        <div className={styles.connectivity} role="status">
          {isOnline ? null : (
            <span
              className={styles.offlinePill}
              title="Your browser has no network connection. This does not reflect dispatch or paging."
            >
              <WifiOff size={14} aria-hidden="true" />
              Offline — changes won&rsquo;t save
            </span>
          )}
        </div>
      </div>
      <div className={styles.topbarRight}>
        {notifications}
        {primaryRole ? (
          <span className={styles.roleLabel}>{ROLE_LABEL[primaryRole] ?? primaryRole}</span>
        ) : null}
        <IconButton
          icon={isCab ? Sun : Moon}
          label={isCab ? 'Switch to day palette' : 'Switch to cab palette'}
          onClick={() => setPalette(isCab ? 'day' : 'cab')}
        />
      </div>
    </header>
  );
}
