import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { useAuth } from './AuthContext';
import { DemoAuthProvider, isDemoMode } from './demoMode';

describe('isDemoMode', () => {
  test('is on only when DEMO_MODE is "true"', () => {
    expect(isDemoMode({ DEMO_MODE: 'true' })).toBe(true);
    expect(isDemoMode({ DEMO_MODE: 'false' })).toBe(false);
    expect(isDemoMode({})).toBe(false);
  });

  // A demo session is fake; it must never be presented to a real backend.
  test('is refused whenever an API is configured', () => {
    expect(isDemoMode({ DEMO_MODE: 'true', API_BASE_URL: 'https://api.example.org' })).toBe(false);
  });
});

function Probe() {
  const auth = useAuth();
  return (
    <Text>{`${String(auth.isAuthenticated)} ${auth.memberId ?? ''} ${auth.roles.join(',')}`}</Text>
  );
}

test('the demo session is a signed-in officer matching the mock data, with no tokens', async () => {
  let token: string | null = 'unset';
  function TokenProbe() {
    const auth = useAuth();
    void auth.getAccessToken().then((t) => {
      token = t;
    });
    return null;
  }
  await render(
    <DemoAuthProvider>
      <Probe />
      <TokenProbe />
    </DemoAuthProvider>,
  );
  expect(screen.getByText('true MBR-0012 MEMBER,OFFICER')).toBeTruthy();
  await Promise.resolve();
  expect(token).toBeNull();
});
