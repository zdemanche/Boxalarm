import { Component, lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { SignInPage } from './pages/SignInPage';
import { GlobalTokensStyle } from './styles/GlobalTokensStyle';

const AuthCallbackPage = lazy(() =>
  import('./pages/AuthCallbackPage').then((mod) => ({ default: mod.AuthCallbackPage })),
);
const LandingPage = lazy(() =>
  import('./pages/LandingPage').then((mod) => ({ default: mod.LandingPage })),
);

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

function RootRoute() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return null;
  return isAuthenticated ? <LandingPage /> : <SignInPage />;
}

export function App() {
  return (
    <ConfigErrorBoundary>
      <GlobalTokensStyle />
      <AuthProvider>
        <BrowserRouter>
          <Suspense fallback={null}>
            <Routes>
              <Route path="/" element={<RootRoute />} />
              <Route path="/auth/callback" element={<AuthCallbackPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </ConfigErrorBoundary>
  );
}
