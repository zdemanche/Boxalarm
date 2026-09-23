import { NavigationContainer } from '@react-navigation/native';
import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AlertsStack } from './AlertsStack';

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
