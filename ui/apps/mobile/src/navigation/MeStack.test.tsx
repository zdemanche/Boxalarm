import { NavigationContainer } from '@react-navigation/native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { MeStack } from './MeStack';

jest.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ signOut: jest.fn(async () => {}) }),
}));

async function renderMeStack() {
  return await render(
    <SafeAreaProvider>
      <NavigationContainer>
        <MeStack />
      </NavigationContainer>
    </SafeAreaProvider>,
  );
}

test('opens on the profile home screen', async () => {
  const { findByText } = await renderMeStack();
  expect(await findByText('Certifications')).toBeTruthy();
});

test('navigating to Certifications shows the certification list', async () => {
  const { findByText } = await renderMeStack();

  await act(async () => {
    fireEvent.press(await findByText('Certifications'));
  });
  expect(await findByText('FF1')).toBeTruthy();
});
