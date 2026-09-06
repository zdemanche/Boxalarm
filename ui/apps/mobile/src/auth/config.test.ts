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
