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

test('buildForgotPasswordUrl points at Cognito Hosted UI forgotPassword with the web client', async () => {
  vi.stubEnv('COGNITO_HOSTED_UI_ORIGIN', 'https://boxalarm.auth.us-east-1.amazoncognito.com');
  const { buildForgotPasswordUrl } = await import('./config');
  const url = new URL(buildForgotPasswordUrl());
  expect(url.origin).toBe('https://boxalarm.auth.us-east-1.amazoncognito.com');
  expect(url.pathname).toBe('/forgotPassword');
  expect(url.searchParams.get('client_id')).toBe('test-web-client');
  expect(url.searchParams.get('redirect_uri')).toBe(`${window.location.origin}/auth/callback`);
});

test('buildForgotPasswordUrl throws when the hosted UI origin is missing', async () => {
  vi.stubEnv('COGNITO_HOSTED_UI_ORIGIN', '');
  const { buildForgotPasswordUrl } = await import('./config');
  expect(() => buildForgotPasswordUrl()).toThrow(/COGNITO_HOSTED_UI_ORIGIN/);
});
