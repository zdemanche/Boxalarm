import { NavigationContainer } from '@react-navigation/native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ChecksStack } from './ChecksStack';

async function renderChecksStack() {
  return await render(
    <SafeAreaProvider>
      <NavigationContainer>
        <ChecksStack />
      </NavigationContainer>
    </SafeAreaProvider>,
  );
}

test('opens on the apparatus picker', async () => {
  const { findByText } = await renderChecksStack();
  expect(await findByText('ENGINE-2')).toBeTruthy();
});

test('selecting an apparatus opens its check runner', async () => {
  const { findByText } = await renderChecksStack();

  await act(async () => {
    fireEvent.press(await findByText('ENGINE-2'));
  });
  expect(await findByText('Tires and wheels')).toBeTruthy();
});
