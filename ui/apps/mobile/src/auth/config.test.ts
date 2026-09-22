jest.mock('react-native-config', () => ({
  __esModule: true,
  default: {
    COGNITO_ISSUER: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
    COGNITO_NATIVE_CLIENT_ID: 'native-client',
  },
}));

import { buildOidcConfig } from './config';

test('the redirectUrl is pinned to boxalarm://auth', () => {
  const config = buildOidcConfig();
  expect(config.redirectUrl).toBe('boxalarm://auth');
});

test('a missing COGNITO_ISSUER or COGNITO_NATIVE_CLIENT_ID throws rather than starting with a bad config', () => {
  jest.resetModules();
  jest.doMock('react-native-config', () => ({ __esModule: true, default: {} }));

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const configModule = require('./config') as typeof import('./config');
  const { buildOidcConfig: buildWithMissingConfig } = configModule;

  expect(() => buildWithMissingConfig()).toThrow();
});

test('buildForgotPasswordUrl redirects to a scheme distinct from the boxalarm://auth OIDC callback', () => {
  jest.resetModules();
  jest.doMock('react-native-config', () => ({
    __esModule: true,
    default: {
      COGNITO_ISSUER: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
      COGNITO_NATIVE_CLIENT_ID: 'native-client',
      COGNITO_HOSTED_UI_ORIGIN: 'https://boxalarm.auth.us-east-1.amazoncognito.com',
    },
  }));

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const configModule = require('./config') as typeof import('./config');
  const url = new URL(configModule.buildForgotPasswordUrl());

  expect(url.origin).toBe('https://boxalarm.auth.us-east-1.amazoncognito.com');
  expect(url.pathname).toBe('/forgotPassword');
  expect(url.searchParams.get('client_id')).toBe('native-client');
  // Must NOT be boxalarm://auth — that's react-native-app-auth's authorize()/refresh() OIDC
  // callback, which this flow never goes through.
  expect(url.searchParams.get('redirect_uri')).toBe('boxalarm://sign-in');
});

test('buildForgotPasswordUrl throws when COGNITO_HOSTED_UI_ORIGIN is missing', () => {
  jest.resetModules();
  jest.doMock('react-native-config', () => ({
    __esModule: true,
    default: {
      COGNITO_ISSUER: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
      COGNITO_NATIVE_CLIENT_ID: 'native-client',
    },
  }));

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const configModule = require('./config') as typeof import('./config');

  expect(() => configModule.buildForgotPasswordUrl()).toThrow(/COGNITO_HOSTED_UI_ORIGIN/);
});
