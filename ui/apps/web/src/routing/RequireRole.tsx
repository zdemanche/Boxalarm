import { useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ForbiddenState } from '../components/ForbiddenState';
import { canAccessPath } from './routeTable';

export function RequireRole({ children }: { children: React.ReactNode }) {
  const { roles } = useAuth();
  const { pathname } = useLocation();

  if (!canAccessPath(pathname, roles)) {
    return (
      <ForbiddenState
        problem={{
          title: 'Forbidden',
          detail: 'You do not have access to this page.',
          traceId: 'route-guard',
        }}
      />
    );
  }

  return children;
}
