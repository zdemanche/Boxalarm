import { Outlet, useLocation } from 'react-router-dom';
import { ToastProvider } from './ui/Toast';
import { DemoBanner } from './DemoBanner';
import { LiveRegionProvider } from './LiveRegion';
import { PrimaryNav } from './PrimaryNav';
import { RouteErrorBoundary } from './RouteErrorBoundary';
import { SkipToContentLink } from './SkipToContentLink';
import { TopBar } from './TopBar';
import styles from './AppShell.module.css';

export function AppShell() {
  const location = useLocation();
  return (
    <LiveRegionProvider>
      <ToastProvider>
        <SkipToContentLink />
        {import.meta.env.VITE_DEMO === 'true' && <DemoBanner />}
        <div className={styles.shell}>
          <PrimaryNav />
          <TopBar />
          <div className={styles.main}>
            {/* Keyed by path so navigating to a different route also recovers a tripped
                boundary, not just its own "Try again" button. Each page owns its own <main
                id="main-content"> landmark, so this wrapper stays a plain <div>. */}
            <RouteErrorBoundary key={location.pathname}>
              <Outlet />
            </RouteErrorBoundary>
          </div>
        </div>
      </ToastProvider>
    </LiveRegionProvider>
  );
}
