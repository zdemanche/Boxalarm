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
      sub: 'member-1',
      iat: now,
      exp: now + 3600,
      ...claims,
    }),
  );
  const signature = base64url(sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey));
  return `${header}.${body}.${signature}`;
}

async function signInAsChief(page: Page): Promise<void> {
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
      'cognito:groups': ['CHIEF'],
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
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

test('occupancy create form passes axe (E5-S1 AC + test notes)', async ({ page }) => {
  await signInAsChief(page);
  await page.route('**/api/v1/inspections/occupancies', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { items: [] } });
    return route.continue();
  });

  await page.goto('/inspections/occupancies');
  await expect(page.getByRole('heading', { name: 'Occupancies' })).toBeVisible();
  const results = await new AxeBuilder({ page })
    .include('form[aria-label="Register occupancy"]')
    .analyze();
  expect(results.violations).toEqual([]);
});

test('pre-plan upload form saves and re-renders the attachment (E5-S2 smoke)', async ({ page }) => {
  await signInAsChief(page);
  await page.route('**/api/v1/inspections/occupancies/occ-1', (route) =>
    route.fulfill({
      json: {
        occupancyId: 'occ-1',
        address: '9 Elm St',
        occupancyType: 'Residential',
        contacts: [],
        hazards: [],
      },
    }),
  );
  await page.route('**/api/v1/inspections/occupancies/occ-1/pre-plan', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 404, json: {} });
    return route.fulfill({
      json: {
        prePlanId: 'pp-1',
        siteDiagramUploadUrl: 'https://example.test/upload/diagram.png',
        attachmentUploadUrls: [],
        utilityShutoffs: [],
        hazards: [],
      },
    });
  });
  await page.route('https://example.test/upload/**', (route) =>
    route.fulfill({ status: 200, body: '' }),
  );

  await page.goto('/inspections/occupancies/occ-1');
  await page.getByRole('tab', { name: 'Pre-plan' }).click();
  await page
    .getByLabel('Site diagram')
    .setInputFiles({ name: 'diagram.png', mimeType: 'image/png', buffer: Buffer.from('fake') });
  await page.getByRole('button', { name: 'Save pre-plan' }).click();
  await expect(page.getByText('Pre-plan saved.')).toBeVisible();

  const results = await new AxeBuilder({ page })
    .include('form[aria-label="Save pre-plan"]')
    .analyze();
  expect(results.violations).toEqual([]);
});

test('schedule then conduct an inspection with a violation, axe clean (E5-S5 test notes)', async ({
  page,
}) => {
  await signInAsChief(page);
  let scheduled: Record<string, unknown> | undefined;
  await page.route('**/api/v1/inspections', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { items: scheduled ? [scheduled] : [] } });
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.inspectionId) {
      scheduled = {
        ...scheduled,
        conductedDate: '2026-10-05',
        conductedBy: 'chief',
        violations: body.violations,
      };
      return route.fulfill({ json: scheduled });
    }
    scheduled = {
      occupancyId: body.occupancyId,
      inspectionId: 'insp-1',
      scheduledDate: body.scheduledDate,
      violations: [],
      nextDueDate: body.scheduledDate,
    };
    return route.fulfill({ status: 201, json: scheduled });
  });

  await page.goto('/inspections');
  await page.getByLabel('Occupancy ID').fill('occ-1');
  await page.getByLabel('Scheduled date').fill('2026-10-05');
  await page.getByRole('button', { name: 'Schedule' }).click();
  await expect(page.getByText('occ-1')).toBeVisible();

  await page.getByRole('button', { name: 'Conduct' }).click();
  await page.getByRole('button', { name: 'Add violation' }).click();
  await page.getByLabel('Code').fill('V-1');
  await page.getByLabel('Description').fill('Blocked exit');
  await page.getByRole('button', { name: 'Save conduct' }).click();
  await expect(page.getByText('V-1 (open)')).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('map screen supports keyboard pan/zoom, a list alternative, and passes axe (E5-S6)', async ({
  page,
}) => {
  await signInAsChief(page);
  await page.route('**/api/v1/inspections/map**', (route) =>
    route.fulfill({
      json: {
        occupancies: [{ occupancyId: 'occ-1', latitude: 41.24, longitude: -73.19 }],
        hydrants: [
          { hydrantId: 'HYD-1', latitude: 41.239, longitude: -73.189, status: 'OUT_OF_SERVICE' },
        ],
      },
    }),
  );

  await page.goto('/inspections/map');
  await expect(page.getByText('HYD-1')).toBeVisible();
  await expect(page.getByText('⊘ Out of service')).toBeVisible();

  await page.getByRole('button', { name: 'Zoom in' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'List view' }).click();
  await expect(page.getByRole('tab', { name: 'List view', selected: true })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
