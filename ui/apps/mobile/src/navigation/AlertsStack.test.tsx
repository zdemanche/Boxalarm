import { NavigationContainer } from '@react-navigation/native';
import { act, fireEvent, render } from '@testing-library/react-native';
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
  expect(await findByRole('button', { name: 'Send test alert' })).toBeTruthy();
});

test('sending a test alert opens its dispatch detail', async () => {
  const { findByRole, findByText } = await renderAlertsStack();

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Send test alert' }));
  });

  expect(await findByText('Self-test')).toBeTruthy();
});
