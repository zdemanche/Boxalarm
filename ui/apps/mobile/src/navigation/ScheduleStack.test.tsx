import { NavigationContainer } from '@react-navigation/native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ScheduleStack } from './ScheduleStack';

async function renderScheduleStack() {
  return await render(
    <SafeAreaProvider>
      <NavigationContainer>
        <ScheduleStack />
      </NavigationContainer>
    </SafeAreaProvider>,
  );
}

test('opens on the shift board', async () => {
  const { findAllByText } = await renderScheduleStack();
  expect((await findAllByText('STATION-1')).length).toBeGreaterThan(0);
});

test('selecting a shift opens its detail', async () => {
  const { findAllByText, findByText } = await renderScheduleStack();

  await act(async () => {
    fireEvent.press((await findAllByText('STATION-1'))[0]!);
  });
  expect(await findByText('DRIVER')).toBeTruthy();
});
