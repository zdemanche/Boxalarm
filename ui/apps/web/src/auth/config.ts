export interface OidcRuntimeConfig {
  authority: string;
  client_id: string;
  redirect_uri: string;
  post_logout_redirect_uri: string;
  silent_redirect_uri: string;
  response_type: 'code';
  scope: string;
  automaticSilentRenew: true;
  loadUserInfo: false;
  monitorSession: false;
}

export function buildOidcConfig(): OidcRuntimeConfig {
  const authority = import.meta.env.COGNITO_ISSUER;
  const client_id = import.meta.env.COGNITO_WEB_CLIENT_ID;

  if (!authority || !client_id) {
    throw new Error('Missing COGNITO_ISSUER or COGNITO_WEB_CLIENT_ID');
  }

  return {
    authority,
    client_id,
    redirect_uri: `${window.location.origin}/auth/callback`,
    post_logout_redirect_uri: window.location.origin,
    silent_redirect_uri: `${window.location.origin}/silent-renew.html`,
    response_type: 'code',
    scope: 'openid profile email',
    automaticSilentRenew: true,
    loadUserInfo: false,
    monitorSession: false,
  };
}

/**
 * Cognito Hosted UI forgot-password entry. Requires COGNITO_HOSTED_UI_ORIGIN
 * (e.g. https://boxalarm.auth.us-east-1.amazoncognito.com) from E8-S2-INFRA.
 *
 * Redirects to /login rather than /auth/callback deliberately: /auth/callback is the
 * oidc-client-ts sign-in-redirect route, which expects a `state` param matching one it stored
 * before starting an authorize request. A password-reset redirect from the Hosted UI carries no
 * such state (this flow never went through oidc-client-ts's signinRedirect), so landing it on
 * /auth/callback produced a "Sign-in could not be completed" error even after a successful
 * reset. /login has no such expectation and just lets the member sign in with their new
 * password.
 */
export function buildForgotPasswordUrl(): string {
  const origin = import.meta.env.COGNITO_HOSTED_UI_ORIGIN;
  const clientId = import.meta.env.COGNITO_WEB_CLIENT_ID;
  if (!origin || !clientId) {
    throw new Error('Missing COGNITO_HOSTED_UI_ORIGIN or COGNITO_WEB_CLIENT_ID');
  }

  const redirectUri = `${window.location.origin}/login`;
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: 'openid profile email',
    redirect_uri: redirectUri,
  });
  return `${origin.replace(/\/$/, '')}/forgotPassword?${params.toString()}`;
}
