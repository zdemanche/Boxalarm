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

/** Cognito Hosted UI forgot-password for the native app client (opens in system browser). */
export function buildForgotPasswordUrl(): string {
  const origin = Config.COGNITO_HOSTED_UI_ORIGIN;
  const clientId = Config.COGNITO_NATIVE_CLIENT_ID;
  if (!origin || !clientId) {
    throw new Error('Missing COGNITO_HOSTED_UI_ORIGIN or COGNITO_NATIVE_CLIENT_ID');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: 'openid profile email',
    redirect_uri: 'boxalarm://auth',
  });
  return `${origin.replace(/\/$/, '')}/forgotPassword?${params.toString()}`;
}
