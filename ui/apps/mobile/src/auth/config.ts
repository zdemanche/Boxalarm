import Config from 'react-native-config';
import type { AuthConfiguration } from 'react-native-app-auth';

export function buildOidcConfig(): AuthConfiguration {
  const issuer = Config.COGNITO_ISSUER;
  const clientId = Config.COGNITO_NATIVE_CLIENT_ID;

  if (!issuer || !clientId) {
    throw new Error('Missing COGNITO_ISSUER or COGNITO_NATIVE_CLIENT_ID');
  }

  return {
    issuer,
    clientId,
    redirectUrl: 'boxalarm://auth',
    scopes: ['openid', 'profile', 'email'],
  };
}
