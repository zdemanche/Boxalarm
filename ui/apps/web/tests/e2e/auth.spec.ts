import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { SignInPage } from '../pages/SignIn.page';

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test';
const CLIENT_ID = 'test-web-client';
const KID = 'test-kid';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function issueIdToken(privateKey: KeyObject, claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }));
  const now = Math.floor(Date.now() / 1000);
  const body = base64url(
    JSON.stringify({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'member-1',
      iat: now,
      exp: now + 3600,
      ...claims,
    }),
  );
  const signature = base64url(sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey));
  return `${header}.${body}.${signature}`;
}

async function stubCognito(
  page: Page,
  privateKey: KeyObject,
  jwk: JsonWebKey,
  options: { expiresInSeconds?: number; onTokenIssued?: () => void } = {},
): Promise<void> {
  const { expiresInSeconds = 3600, onTokenIssued } = options;
  let capturedNonce: string | undefined;

  await page.route(`${ISSUER}/.well-known/openid-configuration`, (route) =>
    route.fulfill({
      json: {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth2/authorize`,
        token_endpoint: `${ISSUER}/oauth2/token`,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      },
    }),
  );

  await page.route(`${ISSUER}/.well-known/jwks.json`, (route) =>
    route.fulfill({ json: { keys: [{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' }] } }),
  );

  await page.route(`${ISSUER}/oauth2/authorize**`, async (route) => {
    const url = new URL(route.request().url());
    capturedNonce = url.searchParams.get('nonce') ?? undefined;
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    await route.fulfill({
      status: 302,
      headers: { location: `${redirectUri}?code=test-code&state=${state}` },
    });
  });

  await page.route(`${ISSUER}/oauth2/token`, async (route) => {
    onTokenIssued?.();
    const idToken = issueIdToken(privateKey, {
      'cognito:groups': ['CHIEF'],
      ...(capturedNonce ? { nonce: capturedNonce } : {}),
    });
    await route.fulfill({
      json: {
        access_token: 'test-access-token',
        id_token: idToken,
        refresh_token: 'test-refresh-token',
        token_type: 'Bearer',
        expires_in: expiresInSeconds,
      },
    });
  });
}

test.describe('sign in once and forget (F9.1 / N5.2)', () => {
  test('sign-in screen has no MFA challenge and passes a full-page accessibility scan', async ({
    page,
  }) => {
    const signIn = new SignInPage(page);
    await signIn.goto();

    await expect(signIn.signInButton).toBeVisible();
    await expect(page.getByText(/mfa/i)).toHaveCount(0);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('a completed sign-in outlives access-token expiry, renewing silently with no re-authentication prompt anywhere', async ({
    page,
  }) => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
    let tokenCalls = 0;
    await stubCognito(page, privateKey, jwk, {
      expiresInSeconds: 2,
      onTokenIssued: () => {
        tokenCalls += 1;
      },
    });

    const signIn = new SignInPage(page);
    await signIn.goto();
    await signIn.signInButton.click();

    const dashboard = page.getByRole('heading', { name: 'Chief dashboard' });
    await expect(dashboard).toBeVisible();
    expect(tokenCalls).toBe(1);

    await expect.poll(() => tokenCalls, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

    await expect(dashboard).toBeVisible();
    expect(page.url()).not.toContain('/auth/callback');
    await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
    await expect(page.getByText(/re-?authenticat/i)).toHaveCount(0);
  });
});
