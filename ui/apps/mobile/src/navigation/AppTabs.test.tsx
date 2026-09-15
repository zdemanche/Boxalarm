import { NavigationContainer } from '@react-navigation/native';
import { act, fireEvent, render } from '@testing-library/react-native';
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

test('opens on the Alerts tab by default, showing its real content', async () => {
  const { findByRole } = await renderTabs();

  expect(await findByRole('button', { name: 'Send test alert' })).toBeTruthy();
});

test("switching tabs shows that tab's real content - Checks (5), Schedule (6), Alerts (7)", async () => {
  const { findByText, findAllByText, findByRole } = await renderTabs();

  expect(await findByRole('button', { name: 'Send test alert' })).toBeTruthy();

  await act(async () => {
    fireEvent.press(await findByText('Checks'));
  });
  expect(await findByText('ENGINE-2')).toBeTruthy();

  await act(async () => {
    fireEvent.press(await findByText('Schedule'));
  });
  expect((await findAllByText('STATION-1')).length).toBeGreaterThan(0);
});
