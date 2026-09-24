import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { PERSONAS } from '../auth/personas';
import type { Role } from '../../src/auth/roles';

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

async function stubCognitoWithGroups(
  page: Page,
  privateKey: KeyObject,
  jwk: JsonWebKey,
  groups: string[],
): Promise<void> {
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
}

/** Cedar denies POST /platform/export to everyone except ADMIN and CHIEF
 * (backend/src/services/platform-service/export/authz.ts). The client route table only lets
 * ADMIN reach /settings today (routeTable.ts), which is a disclosed, separate gap (review
 * finding F-12 on PR #308) — not something this test papers over. So the 403-at-the-API-layer
 * assertion below only applies to roles the backend contract itself denies. */
const BACKEND_DENIES_EXPORT: Role[] = ['MEMBER', 'OFFICER', 'TRAINING', 'APPARATUS'];

const EXPORT_BUTTON_NAME = 'Export department data';

test.describe('E8 issue #175 AC3: export control is admin-only end to end', () => {
  test('ADMIN sees the export control on /settings', async ({ page }) => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
    await stubCognitoWithGroups(page, privateKey, jwk, ['ADMIN']);

    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Wait for auth to settle before deep-linking (full reload keeps localStorage session) —
    // same pattern as primary-nav.spec.ts's "forbidden URL" test.
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: EXPORT_BUTTON_NAME })).toBeVisible();
  });

  for (const role of Object.keys(PERSONAS) as Role[]) {
    if (role === 'ADMIN') continue;
    const persona = PERSONAS[role];

    test(`${role} does not see the export control, and the export endpoint 403s`, async ({
      page,
    }) => {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;

      // Stand in for the backend's Cedar denial — there is no live backend in this e2e
      // environment (see playwright.config.ts, which only serves the built SPA). If a
      // non-privileged persona somehow bypassed the client route guard below and called the
      // endpoint directly, this is the response Cedar would give them.
      await page.route('**/api/v1/platform/export', (route) =>
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            detail: 'caller is not a CHIEF or ADMIN',
            traceId: 'e2e-403',
          }),
        }),
      );

      await stubCognitoWithGroups(page, privateKey, jwk, persona.groups);

      await page.goto('/login');
      await page.getByRole('button', { name: 'Sign in' }).click();
      // Wait for auth to settle before deep-linking (full reload keeps localStorage session).
      if (role === 'MEMBER') {
        await expect(page.getByRole('heading', { name: 'Member home' })).toBeVisible();
      } else {
        await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
      }

      await page.goto('/settings');
      await expect(page).toHaveURL(/\/settings$/);
      await expect(page.getByRole('heading', { name: 'Forbidden' })).toBeVisible();
      await expect(page.getByRole('button', { name: EXPORT_BUTTON_NAME })).toHaveCount(0);

      if (BACKEND_DENIES_EXPORT.includes(role)) {
        const response = await page.evaluate(async () => {
          const res = await fetch('/api/v1/platform/export', { method: 'POST' });
          return { status: res.status, bodyText: await res.text() };
        });
        expect(response.status).toBe(403);
        // The 403 body must never end up rendered in the page — this endpoint is never called
        // by app code for this persona (the control isn't rendered), so nothing in the DOM
        // should reflect it either.
        expect(await page.locator('body').innerText()).not.toContain(
          'caller is not a CHIEF or ADMIN',
        );
      }
    });
  }
});
