import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

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
      sub: 'officer-1',
      iat: now,
      exp: now + 3600,
      ...claims,
    }),
  );
  const signature = base64url(sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey));
  return `${header}.${body}.${signature}`;
}

async function signInAs(page: Page, groups: string[]): Promise<void> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
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
    const idToken = issueIdToken(privateKey, {
      'cognito:groups': groups,
      ...(capturedNonce ? { nonce: capturedNonce } : {}),
    });
    await route.fulfill({
      json: {
        access_token: 'test-access-token',
        id_token: idToken,
        refresh_token: 'test-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
      },
    });
  });

  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

test('roster table headers are associated with cells and the page passes axe (AC4)', async ({
  page,
}) => {
  await page.route('**/api/v1/personnel/members', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            memberId: 'm-1',
            firstName: 'Alex',
            lastName: 'Rivera',
            email: 'arivera@nicholsfd.org',
            phone: '203-555-0111',
            status: 'ACTIVE',
            joinDate: '2018-04-12',
            rank: 'Chief',
            agencyId: 'nichols-fd',
          },
        ],
      },
    }),
  );

  await signInAs(page, ['OFFICER']);
  await page.goto('/personnel');
  await expect(page.getByRole('heading', { name: 'Personnel' })).toBeVisible();

  const table = page.getByRole('table');
  await expect(table).toBeVisible();
  const nameRowHeader = page.getByRole('rowheader', { name: /Rivera, Alex/ });
  await expect(nameRowHeader).toBeVisible();

  const results = await new AxeBuilder({ page }).include('table').analyze();
  expect(results.violations).toEqual([]);
});
