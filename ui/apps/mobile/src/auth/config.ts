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

/**
 * Cognito Hosted UI forgot-password for the native app client (opens in system browser).
 *
 * Deliberately redirects to a scheme distinct from `boxalarm://auth` (the redirectUrl used by
 * authorize()/refresh() in AuthContext): `boxalarm://auth` is react-native-app-auth's OIDC
 * callback, which react-native-app-auth's own in-flight authorize() session expects to consume
 * with matching PKCE/state. A Hosted-UI password reset never goes through authorize(), so
 * redirecting it to the same URI left the callback effectively unhandled and gave the member no
 * feedback after a successful reset. `boxalarm://sign-in` just reopens the app on the (already
 * showing, since the member isn't authenticated yet) sign-in screen instead.
 */
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
    redirect_uri: 'boxalarm://sign-in',
  });
  return `${origin.replace(/\/$/, '')}/forgotPassword?${params.toString()}`;
}
