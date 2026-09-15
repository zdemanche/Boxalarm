import { Outlet } from 'react-router-dom';
import { LiveRegionProvider } from './LiveRegion';
import { PrimaryNav } from './PrimaryNav';
import { SkipToContentLink } from './SkipToContentLink';

export function AppShell() {
  return (
    <LiveRegionProvider>
      <SkipToContentLink />
      <PrimaryNav />
      <Outlet />
    </LiveRegionProvider>
  );
}
