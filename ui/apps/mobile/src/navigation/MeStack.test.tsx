import { NavigationContainer } from '@react-navigation/native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { MeStack } from './MeStack';

// One stable object, like the real context value - a fresh object per call re-fires every
// effect keyed on the auth value and loops the render.
jest.mock('../auth/AuthContext', () => {
  const auth = { isAuthenticated: false, memberId: null };
  return {
    useAuth: () => ({ signOut: jest.fn(async () => {}) }),
    useOptionalAuth: () => auth,
  };
});

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
