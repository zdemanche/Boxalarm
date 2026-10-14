import { useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ForbiddenState } from '../components/ForbiddenState';
import { canAccessPath, routeForPath } from './routeTable';

export function RequireRole({ children }: { children: React.ReactNode }) {
  const { roles } = useAuth();
  const { pathname } = useLocation();

  if (!canAccessPath(pathname, roles)) {
    // The route table's role list is exactly who can open this page, so the refusal names them.
    const route = routeForPath(pathname);
    return (
      <ForbiddenState
        problem={{
          title: 'Forbidden',
          detail: 'You do not have access to this page.',
          traceId: 'route-guard',
        }}
        allowedRoles={route?.roles}
        pageLabel={route?.label}
      />
    );
  }

  return children;
}
