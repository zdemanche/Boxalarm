import { NavigationContainer } from '@react-navigation/native';
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppTabs } from './AppTabs';

jest.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ signOut: jest.fn(async () => {}) }),
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

test('renders all four tabs from architecture.md §7.2: Alerts, Checks, Schedule, Me', async () => {
  const { findByText } = await renderTabs();

  expect(await findByText('Alerts')).toBeTruthy();
  expect(await findByText('Checks')).toBeTruthy();
  expect(await findByText('Schedule')).toBeTruthy();
  expect(await findByText('Me')).toBeTruthy();
});

test('opens on the Alerts tab by default', async () => {
  const { findByText } = await renderTabs();

  expect(await findByText('Alerts stack coming in phase 7')).toBeTruthy();
});

test("switching tabs shows that tab's placeholder content", async () => {
  const { findByText } = await renderTabs();

  fireEvent.press(await findByText('Checks'));
  expect(await findByText('Checks stack coming in phase 5')).toBeTruthy();
});
