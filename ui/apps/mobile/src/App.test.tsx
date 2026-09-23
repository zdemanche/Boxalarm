import { palette, radius, touchTarget } from '@boxalarm/design-tokens';
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

test('the sign-in button uses the accent color and meets the N3.5 touch-target minimum', async () => {
  const { findByRole } = await render(<App />);

  const button = await findByRole('button', { name: 'Sign in' });
  expect(button).toHaveStyle({ backgroundColor: palette.day.accent, borderRadius: radius.default });
  const style = Array.isArray(button.props.style)
    ? Object.assign({}, ...button.props.style)
    : button.props.style;
  expect(style.minHeight).toBeGreaterThanOrEqual(touchTarget.baseline.ios);
  expect(style.minWidth).toBeGreaterThanOrEqual(touchTarget.baseline.ios);
});

test('a valid stored session lands on the AppTabs shell (Alerts · Checks · Schedule · Me)', async () => {
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

  expect(await findByText('Alerts')).toBeTruthy();
  expect(await findByText('Checks')).toBeTruthy();
  expect(await findByText('Schedule')).toBeTruthy();
  expect(await findByText('Me')).toBeTruthy();
});

test('the authenticated shell shows the persistent sync-status banner above the tabs', async () => {
  const idToken = `h.${base64url(JSON.stringify({ roles: ['MEMBER'] }))}.s`;
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

  expect(await findByText(/waiting to sync/i)).toBeTruthy();
});
