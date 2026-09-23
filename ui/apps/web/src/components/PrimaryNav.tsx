import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { routesForRoles } from '../routing/routeTable';

export function PrimaryNav() {
  const { roles, signOut, isAuthenticated } = useAuth();
  const links = routesForRoles(roles);

  if (!isAuthenticated) return null;

  return (
    <nav aria-label="Primary" style={{ padding: 'var(--boxalarm-spacing-md)' }}>
      <ul
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--boxalarm-spacing-md)',
          listStyle: 'none',
          margin: 0,
          padding: 0,
        }}
      >
        {links.map((route) => (
          <li key={route.navPath}>
            <NavLink
              to={route.navPath}
              style={({ isActive }) => ({
                color: 'var(--boxalarm-fg)',
                fontWeight: isActive ? 700 : 400,
                textDecoration: isActive ? 'underline' : 'none',
                minHeight: 44,
                display: 'inline-flex',
                alignItems: 'center',
              })}
              end={route.navPath === '/'}
            >
              {route.label}
            </NavLink>
          </li>
        ))}
        <li style={{ marginLeft: 'auto' }}>
          <button
            type="button"
            onClick={() => void signOut()}
            style={{
              minHeight: 44,
              minWidth: 44,
              padding: '0 var(--boxalarm-spacing-md)',
              background: 'transparent',
              color: 'var(--boxalarm-fg)',
              border: '1px solid var(--boxalarm-fg)',
              borderRadius: 'var(--boxalarm-radius-default)',
              cursor: 'pointer',
            }}
          >
            Sign out
          </button>
        </li>
      </ul>
    </nav>
  );
}
