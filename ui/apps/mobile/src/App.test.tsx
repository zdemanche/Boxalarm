import { render } from '@testing-library/react-native';
import { getInternetCredentials } from 'react-native-keychain';
import { App } from './App';

jest.mock('react-native-config', () => ({
  __esModule: true,
  default: {
    COGNITO_ISSUER: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
    COGNITO_NATIVE_CLIENT_ID: 'native-client',
  },
}));

jest.mock('react-native-keychain', () => ({
  getInternetCredentials: jest.fn(async () => false),
  setInternetCredentials: jest.fn(async () => ({ service: 'boxalarm-auth', storage: 'keychain' })),
  resetInternetCredentials: jest.fn(async () => true),
}));

jest.mock('react-native-app-auth', () => ({
  authorize: jest.fn(),
  refresh: jest.fn(),
}));

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const mockedGetInternetCredentials = getInternetCredentials as jest.MockedFunction<
  typeof getInternetCredentials
>;

afterEach(() => {
  mockedGetInternetCredentials.mockReset();
  mockedGetInternetCredentials.mockResolvedValue(false);
});

test('a cold start with no stored credentials renders the sign-in screen', async () => {
  const { findByText } = await render(<App />);

  await findByText('Boxalarm');
  expect(await findByText('Sign in')).toBeTruthy();
});

test('a valid stored session renders the highest-priority role dashboard', async () => {
  const idToken = `h.${base64url(JSON.stringify({ roles: ['MEMBER', 'ADMIN'] }))}.s`;
  mockedGetInternetCredentials.mockResolvedValue({
    username: 'boxalarm-auth',
    password: JSON.stringify({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessTokenExpirationDate: new Date(Date.now() + 3600_000).toISOString(),
      idToken,
    }),
    service: 'boxalarm-auth',
    storage: 'keychain',
  } as unknown as Awaited<ReturnType<typeof getInternetCredentials>>);

  const { findByText } = await render(<App />);

  expect(await findByText('Admin dashboard')).toBeTruthy();
});
