import { Outlet, useLocation } from 'react-router-dom';
import { DemoBanner } from './DemoBanner';
import { LiveRegionProvider } from './LiveRegion';
import { PrimaryNav } from './PrimaryNav';
import { RouteErrorBoundary } from './RouteErrorBoundary';
import { SkipToContentLink } from './SkipToContentLink';

export function AppShell() {
  const location = useLocation();
  return (
    <LiveRegionProvider>
      <SkipToContentLink />
      {import.meta.env.VITE_DEMO === 'true' && <DemoBanner />}
      <PrimaryNav />
      {/* Keyed by path so navigating to a different route also recovers a tripped boundary,
          not just its own "Try again" button. */}
      <RouteErrorBoundary key={location.pathname}>
        <Outlet />
      </RouteErrorBoundary>
    </LiveRegionProvider>
  );
}
