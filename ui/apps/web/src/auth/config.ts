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
