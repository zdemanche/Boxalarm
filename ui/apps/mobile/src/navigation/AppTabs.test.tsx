import { NavigationContainer } from '@react-navigation/native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { targetSize } from '@boxalarm/design-tokens';
import { testSafeAreaMetrics } from '../testUtils/safeAreaMetrics';
import { AppTabs } from './AppTabs';

jest.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    signOut: jest.fn(async () => {}),
    isAuthenticated: false,
    isLoading: false,
    roles: [],
    signIn: jest.fn(async () => {}),
    getAccessToken: jest.fn(async () => null),
    renewSilently: jest.fn(async () => null),
  }),
  useOptionalAuth: () => undefined,
}));

async function renderTabs() {
  return await render(
    <SafeAreaProvider>
      <NavigationContainer>
        <AppTabs />
      </NavigationContainer>
    </SafeAreaProvider>,
  );
}

test('renders all four tabs from architecture.md §7.2: Alerts, Apparatus (Checks stack), Schedule, Me', async () => {
  const { findAllByText, findByText } = await renderTabs();

  expect((await findAllByText('Alerts')).length).toBeGreaterThan(0);
  expect((await findAllByText('Apparatus')).length).toBeGreaterThan(0);
  expect(await findByText('Schedule')).toBeTruthy();
  expect(await findByText('Me')).toBeTruthy();
});

test('opens on the Alerts tab by default, showing its real content', async () => {
  const { findByRole } = await renderTabs();

  expect(await findByRole('header', { name: 'Active calls' })).toBeTruthy();
});

test("switching tabs shows that tab's real content - Apparatus (5), Schedule (6), Alerts (7)", async () => {
  const { findByText, findAllByText, findByRole } = await renderTabs();

  expect(await findByRole('header', { name: 'Active calls' })).toBeTruthy();

  await act(async () => {
    fireEvent.press((await findAllByText('Apparatus'))[0]!);
  });
  expect(await findByText('ENGINE-2')).toBeTruthy();

  await act(async () => {
    fireEvent.press(await findByText('Schedule'));
  });
  expect((await findAllByText('STATION-1')).length).toBeGreaterThan(0);
});

test('the tab row clears the field floor once the home-indicator inset is taken out of the bar', async () => {
  const { getByLabelText } = await renderTabs();

  let node = getByLabelText('Alerts, tab, 1 of 4').parent;
  while (node && StyleSheet.flatten(node.props.style)?.height === undefined) node = node.parent;
  const { height, paddingTop, paddingBottom } = StyleSheet.flatten(node!.props.style);
  expect(paddingBottom).toBe(testSafeAreaMetrics.insets.bottom);
  expect(height - paddingTop - paddingBottom).toBeGreaterThanOrEqual(targetSize.field);
});
