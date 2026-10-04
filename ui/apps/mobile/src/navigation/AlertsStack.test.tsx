import { createNavigationContainerRef, NavigationContainer } from '@react-navigation/native';
import { act, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { AuthContextValue } from '../auth/AuthContext';
import { AlertsStack } from './AlertsStack';
import type { AlertsStackParamList } from './AlertsStack';

const mockAuth: { current: AuthContextValue | undefined } = { current: undefined };
jest.mock('../auth/AuthContext', () => ({
  useOptionalAuth: () => mockAuth.current,
}));

jest.mock('../sync/ConnectivityContext', () => ({
  useConnectivity: () => ({ isOnline: true }),
  useOptionalConnectivity: () => ({ isOnline: true }),
}));

function authWithRoles(roles: AuthContextValue['roles']): AuthContextValue {
  return {
    roles,
    memberId: 'MBR-TEST',
    isAuthenticated: true,
    isLoading: false,
    signIn: jest.fn(),
    signOut: jest.fn(),
    getAccessToken: jest.fn(),
    renewSilently: jest.fn(),
  };
}

beforeEach(() => {
  mockAuth.current = undefined;
});

async function renderAlertsStack() {
  return await render(
    <SafeAreaProvider>
      <NavigationContainer>
        <AlertsStack />
      </NavigationContainer>
    </SafeAreaProvider>,
  );
}

test('opens on the alerts home screen', async () => {
  const { findByRole } = await renderAlertsStack();
  expect(await findByRole('header', { name: 'Alerts' })).toBeTruthy();
});

test('a signed-out (no AuthProvider) render is not offered the officer-only manual entry action', async () => {
  const { queryByRole } = await renderAlertsStack();
  expect(queryByRole('button', { name: 'Enter dispatch manually' })).toBeNull();
});

test('deep-linking a MEMBER straight to RidingBoard is blocked, not just the AlertsHome button hidden', async () => {
  mockAuth.current = authWithRoles(['MEMBER']);
  const navigationRef = createNavigationContainerRef<AlertsStackParamList>();

  const { findByRole } = await render(
    <SafeAreaProvider>
      <NavigationContainer ref={navigationRef}>
        <AlertsStack />
      </NavigationContainer>
    </SafeAreaProvider>,
  );

  // Simulates a deep link or programmatic navigation straight to RidingBoard, bypassing
  // AlertsHomeScreen's button (which is only ever client-side visibility).
  await act(async () => {
    navigationRef.navigate('RidingBoard', { dispatchId: 'D-1' });
  });

  expect(await findByRole('header', { name: 'Forbidden' })).toBeTruthy();
});

test('deep-linking an OFFICER to RidingBoard is allowed through', async () => {
  mockAuth.current = authWithRoles(['OFFICER']);
  const navigationRef = createNavigationContainerRef<AlertsStackParamList>();

  const { findByText, queryByRole } = await render(
    <SafeAreaProvider>
      <NavigationContainer ref={navigationRef}>
        <AlertsStack />
      </NavigationContainer>
    </SafeAreaProvider>,
  );

  await act(async () => {
    navigationRef.navigate('RidingBoard', { dispatchId: 'D-1' });
  });

  expect(queryByRole('header', { name: 'Forbidden' })).toBeNull();
  // RidingBoardScreen falls back to the offline mock repository (no auth/API base wired in
  // this test), which seeds a riding board including "Engine 301".
  expect(await findByText('Engine 301')).toBeTruthy();
});

test('a second call is pushed as its own alert screen, not swapped into the first (review CR-1)', async () => {
  const navigationRef = createNavigationContainerRef<AlertsStackParamList>();
  await render(
    <SafeAreaProvider>
      <NavigationContainer ref={navigationRef}>
        <AlertsStack />
      </NavigationContainer>
    </SafeAreaProvider>,
  );

  await act(async () => {
    navigationRef.navigate('AlertDetail', { dispatchId: 'SELFTEST-A' });
  });
  await act(async () => {
    navigationRef.navigate('AlertDetail', { dispatchId: 'SELFTEST-B' });
  });

  const routes = navigationRef.getRootState()?.routes ?? [];
  const alertRoutes = routes.filter((route) => route.name === 'AlertDetail');
  expect(alertRoutes.map((route) => (route.params as { dispatchId: string }).dispatchId)).toEqual([
    'SELFTEST-A',
    'SELFTEST-B',
  ]);
});
