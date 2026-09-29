import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DEMO_NERIS_SCHEMA } from '../../src/features/incidents/nerisSchemaFixture';

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

const incident = {
  incidentId: 'i-1',
  deptId: 'nichols-fd',
  dispatchNumber: '26-001841',
  epochSeconds: 1_700_000_000,
  nerisSchemaVersion: '2026.2',
  corePayload: {
    incident_type: 'FIRE||STRUCTURE_FIRE||ROOM_AND_CONTENTS_FIRE',
    address: '14 Elm St, Trumbull, CT',
  },
  incidentType: 'Structure fire',
  address: '14 Elm St, Trumbull, CT',
  alarmAt: Math.floor(Date.now() / 1000) - 86_400,
  dispatchAt: Math.floor(Date.now() / 1000) - 86_000,
  narrative: 'Working fire, first floor kitchen.',
  status: 'VALIDATED',
  sourceDispatchId: 'd-100',
  createdBy: 'm-1',
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_000,
  secondaryModules: [],
  respondingUnits: [
    {
      incidentId: 'i-1',
      unitId: 'Engine 301',
      unitType: 'APPARATUS',
      dispatchedAt: 1_700_000_030,
      assignedPositions: ['Officer'],
    },
  ],
  respondingMembers: [{ memberId: 'm-rivera', status: 'RESPONDING' }],
};

const VALIDATION_REPORT = {
  blocking: [],
  warnings: [],
  nerisValidatedAt: null,
  sectionsComplete: { core: true, dispatch: true, units: true, narrative: true },
};

const nerisSchema = {
  version: '2026.2+neris-1.5.1',
  apiVersion: '1.5.1',
  incidentTypes: [
    {
      value: 'FIRE||STRUCTURE_FIRE||ROOM_AND_CONTENTS_FIRE',
      label: 'Fire › Structure fire › Room and contents fire',
    },
    { value: 'FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE', label: 'Fire › Structure fire › Chimney fire' },
    { value: 'NOEMERG||CANCELLED', label: 'Noemerg › Cancelled' },
  ],
  modules: {},
};

test('incident list and report pass axe on the default, error, and validated states', async ({
  page,
}) => {
  await page.route('**/api/v1/incidents**', async (route) => {
    const url = route.request().url();
    if (url.includes('/incidents/neris-schema')) {
      await route.fulfill({ json: nerisSchema });
      return;
    }
    if (url.endsWith('/incidents/i-1/validate')) {
      // "What's blocking lock" runs when the report opens: answer it as the API does.
      await route.fulfill({ json: VALIDATION_REPORT });
      return;
    }
    if (url.includes('/incidents/i-1')) {
      await route.fulfill({ json: incident });
      return;
    }
    await route.fulfill({ json: { incidents: [incident] } });
  });

  await signInAs(page, ['OFFICER', 'CHIEF']);
  await page.goto('/incidents');
  await expect(page.getByRole('heading', { name: 'Incidents', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '26-001841' })).toBeVisible();

  const listResults = await new AxeBuilder({ page }).include('main').analyze();
  expect(listResults.violations).toEqual([]);

  await page.getByRole('link', { name: '26-001841' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('14 Elm St');
  await page.getByRole('button', { name: 'Incident type and actions' }).click();
  await page.getByLabel('NERIS incident type').selectOption('FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE');
  await page.getByLabel('Action taken').fill('NOT_A_CODE');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('alert')).toContainText('must be one of: EXTINGUISH');

  const errorResults = await new AxeBuilder({ page }).include('main').analyze();
  expect(errorResults.violations).toEqual([]);

  await page.getByRole('button', { name: 'Review and submit' }).click();
  // Validated is not enough: Submit opens only once an officer has reviewed and locked it.
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
  await expect(
    page.getByText('Submit stays unavailable until an officer reviews and locks the report.'),
  ).toBeVisible();
  const reviewResults = await new AxeBuilder({ page }).include('main').analyze();
  expect(reviewResults.violations).toEqual([]);
});

test('the NERIS module editors pass axe with a module filled in', async ({ page }) => {
  const draft = {
    ...incident,
    status: 'DRAFT',
    corePayload: {
      ...incident.corePayload,
      smoke_alarm: {
        presence: {
          type: 'PRESENT',
          working: false,
          alarm_types: ['HARDWIRED'],
          operation: { alerted_failed_other: { type: 'OPERATED_ALERTED_OCCUPANT' } },
        },
      },
    },
  };
  await page.route('**/api/v1/incidents**', async (route) => {
    const url = route.request().url();
    if (url.includes('/incidents/neris-schema')) {
      await route.fulfill({ json: DEMO_NERIS_SCHEMA });
      return;
    }
    if (url.endsWith('/incidents/i-1/validate')) {
      // "What's blocking lock" runs when the report opens: answer it as the API does.
      await route.fulfill({ json: VALIDATION_REPORT });
      return;
    }
    if (url.includes('/incidents/i-1')) {
      await route.fulfill({ json: draft });
      return;
    }
    await route.fulfill({ json: { incidents: [draft] } });
  });

  await signInAs(page, ['OFFICER', 'CHIEF']);
  await page.goto('/incidents/i-1');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('14 Elm St');
  await page.getByRole('button', { name: 'Fire protection systems' }).click();
  const smoke = page.getByRole('region', { name: 'Smoke alarm' });
  await expect(smoke.getByRole('radio', { name: 'Present', exact: true })).toBeChecked();
  await expect(smoke.getByRole('group', { name: 'Working' })).toBeVisible();

  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect(results.violations).toEqual([]);
});
