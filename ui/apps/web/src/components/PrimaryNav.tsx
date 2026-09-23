import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { routesForRoles } from '../routing/routeTable';
import {
  CalendarClock,
  ClipboardList,
  Flame,
  LayoutDashboard,
  RadioTower,
  ScrollText,
  Settings,
  ShieldAlert,
  Truck,
  Users,
  type LucideIcon,
} from './ui/icons';
import styles from './AppShell.module.css';

// Keyed by navPath prefix so a sibling ticket's route (appended to routeTable.ts) still gets a
// sensible icon without this file needing to change — falls back to LayoutDashboard.
const ICON_BY_PREFIX: Array<[string, LucideIcon]> = [
  ['/alerts', RadioTower],
  ['/incidents', Flame],
  ['/personnel', Users],
  ['/certifications', ShieldAlert],
  ['/apparatus', Truck],
  ['/schedule', CalendarClock],
  ['/reporting', ClipboardList],
  ['/settings', Settings],
  ['/audit-log', ScrollText],
];

function iconFor(navPath: string): LucideIcon {
  return ICON_BY_PREFIX.find(([prefix]) => navPath.startsWith(prefix))?.[1] ?? LayoutDashboard;
}

export function PrimaryNav() {
  const { roles, signOut, isAuthenticated } = useAuth();
  const links = routesForRoles(roles);

  if (!isAuthenticated) return null;

  return (
    <nav aria-label="Primary" className={styles.sidebar}>
      <div className={styles.brand}>
        <Flame size={18} aria-hidden="true" />
        Boxalarm
      </div>
      <ul className={styles.navList}>
        {links.map((route) => {
          const Icon = iconFor(route.navPath);
          return (
            <li key={route.navPath}>
              <NavLink
                to={route.navPath}
                className={({ isActive }) =>
                  [styles.navLink, isActive ? styles.navLinkActive : ''].filter(Boolean).join(' ')
                }
                end={route.navPath === '/'}
              >
                <Icon size={18} aria-hidden="true" />
                {route.label}
              </NavLink>
            </li>
          );
        })}
      </ul>
      <div className={styles.signOutWrap}>
        <button
          type="button"
          onClick={() => void signOut()}
          className={styles.navLink}
          style={{ width: '100%' }}
        >
          Sign out
        </button>
      </div>
    </nav>
  );
}
