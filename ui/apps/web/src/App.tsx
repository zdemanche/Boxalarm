import { Component, lazy, Suspense, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { AppShell } from './components/AppShell';
import { SignInPage } from './pages/SignInPage';
import { RequireAuth } from './routing/RequireAuth';
import { RequireRole } from './routing/RequireRole';
import { GlobalTokensStyle } from './styles/GlobalTokensStyle';

const AuthCallbackPage = lazy(() =>
  import('./pages/AuthCallbackPage').then((mod) => ({ default: mod.AuthCallbackPage })),
);
const LandingPage = lazy(() =>
  import('./pages/LandingPage').then((mod) => ({ default: mod.LandingPage })),
);
const PlaceholderPage = lazy(() =>
  import('./pages/PlaceholderPage').then((mod) => ({ default: mod.PlaceholderPage })),
);
const ApparatusListPage = lazy(() =>
  import('./features/apparatus/ApparatusListPage').then((mod) => ({
    default: mod.ApparatusListPage,
  })),
);
const ApparatusDetailPage = lazy(() =>
  import('./features/apparatus/ApparatusDetailPage').then((mod) => ({
    default: mod.ApparatusDetailPage,
  })),
);
const PersonnelListPage = lazy(() =>
  import('./features/personnel/PersonnelListPage').then((mod) => ({
    default: mod.PersonnelListPage,
  })),
);
const MemberDetailPage = lazy(() =>
  import('./features/personnel/MemberDetailPage').then((mod) => ({
    default: mod.MemberDetailPage,
  })),
);
const CertificationsPage = lazy(() =>
  import('./features/training/CertificationsPage').then((mod) => ({
    default: mod.CertificationsPage,
  })),
);
const TrainingEventsPage = lazy(() =>
  import('./features/training/TrainingEventsPage').then((mod) => ({
    default: mod.TrainingEventsPage,
  })),
);

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

class ConfigErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <main role="alert">
          <h1>Boxalarm can&apos;t start</h1>
          <p>Sign-in configuration is missing or invalid. Contact your department administrator.</p>
        </main>
      );
    }
    return this.props.children;
  }
}

function LoginRoute() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return null;
  if (isAuthenticated) return <Navigate to="/" replace />;
  return <SignInPage />;
}

function roleGuarded(element: ReactNode) {
  return <RequireRole>{element}</RequireRole>;
}

function placeholder(title: string) {
  return roleGuarded(<PlaceholderPage title={title} />);
}

export function App() {
  return (
    <ConfigErrorBoundary>
      <GlobalTokensStyle />
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <BrowserRouter
            basename={import.meta.env.VITE_DEMO === 'true' ? '/Boxalarm-monorepo' : undefined}
          >
            <Suspense fallback={null}>
              <Routes>
                <Route path="/login" element={<LoginRoute />} />
                <Route path="/auth/callback" element={<AuthCallbackPage />} />
                <Route
                  path="/"
                  element={
                    <RequireAuth>
                      <AppShell />
                    </RequireAuth>
                  }
                >
                  <Route index element={<LandingPage />} />
                  <Route path="alerts/roster" element={placeholder('Live roster')} />
                  <Route path="alerts/diagnostics" element={placeholder('Alert diagnostics')} />
                  <Route path="incidents" element={placeholder('Incidents')} />
                  <Route path="incidents/:id" element={placeholder('Incident detail')} />
                  <Route path="personnel" element={roleGuarded(<PersonnelListPage />)} />
                  <Route path="personnel/:id" element={roleGuarded(<MemberDetailPage />)} />
                  <Route path="certifications" element={roleGuarded(<CertificationsPage />)} />
                  <Route path="training/events" element={roleGuarded(<TrainingEventsPage />)} />
                  <Route path="apparatus" element={roleGuarded(<ApparatusListPage />)} />
                  <Route path="apparatus/:id" element={roleGuarded(<ApparatusDetailPage />)} />
                  <Route path="schedule" element={placeholder('Schedule')} />
                  <Route path="reporting" element={placeholder('Reporting')} />
                  <Route path="settings" element={placeholder('Settings')} />
                  <Route path="audit-log" element={placeholder('Audit log')} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </AuthProvider>
      </QueryClientProvider>
    </ConfigErrorBoundary>
  );
}
