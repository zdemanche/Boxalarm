import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { buildOidcConfig } from './config';

beforeEach(() => {
  vi.stubEnv('COGNITO_ISSUER', 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test');
  vi.stubEnv('COGNITO_WEB_CLIENT_ID', 'test-web-client');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test('the redirect_uri is pinned to {origin}/auth/callback', () => {
  const config = buildOidcConfig();
  expect(config.redirect_uri).toBe(`${window.location.origin}/auth/callback`);
});

test('automaticSilentRenew is pinned to true so an expiring token never redirects to sign-in', () => {
  const config = buildOidcConfig();
  expect(config.automaticSilentRenew).toBe(true);
});

test('the silent_redirect_uri points at a minimal static callback document, not the SPA route', () => {
  const config = buildOidcConfig();
  expect(config.silent_redirect_uri).toBe(`${window.location.origin}/silent-renew.html`);
});

test('a missing COGNITO_ISSUER or COGNITO_WEB_CLIENT_ID throws rather than starting with a bad config', () => {
  vi.stubEnv('COGNITO_ISSUER', '');
  expect(() => buildOidcConfig()).toThrow();
});
