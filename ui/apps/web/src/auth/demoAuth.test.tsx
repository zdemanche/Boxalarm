import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AuthProvider, useAuth, useDemoRole } from './AuthContext';

beforeEach(() => {
  vi.stubEnv('VITE_DEMO', 'true');
});
afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

function Probe() {
  const { isAuthenticated, isLoading, roles } = useAuth();
  const { setRole } = useDemoRole();
  if (isLoading) return <p>loading</p>;
  return (
    <div>
      <p>
        {isAuthenticated ? 'authenticated' : 'unauthenticated'}:{roles.join(',')}
      </p>
      <button onClick={() => setRole('APPARATUS')}>switch</button>
    </div>
  );
}

test('demo mode signs the viewer in without any OIDC call and defaults to CHIEF', async () => {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );

  expect(await screen.findByText('authenticated:CHIEF')).toBeTruthy();
});

test('the role switcher changes which role useAuth reports', async () => {
  const user = userEvent.setup();
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );

  await screen.findByText('authenticated:CHIEF');
  await user.click(screen.getByRole('button', { name: 'switch' }));
  expect(await screen.findByText('authenticated:APPARATUS')).toBeTruthy();
});
