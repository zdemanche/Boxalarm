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
      sub: 'training-1',
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
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

test('training officer creates an event, signs up, and records attendance (#152)', async ({
  page,
}) => {
  interface TrainingEvent {
    eventId: string;
    title: string;
    category: string;
    startAt: number;
    endAt: number;
    signedUp: boolean;
  }

  const events: TrainingEvent[] = [];
  const hourPayloads: { attendees: { memberId: string; hours: number }[] }[] = [];

  await page.route('**/api/v1/personnel/members', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/api/v1/training/events**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.endsWith('/training/events') && method === 'GET') {
      await route.fulfill({ json: events });
      return;
    }
    if (url.pathname.endsWith('/training/events') && method === 'POST') {
      const body = route.request().postDataJSON() as Omit<TrainingEvent, 'eventId' | 'signedUp'>;
      const created: TrainingEvent = {
        eventId: 'evt-drill-1',
        title: body.title,
        category: body.category,
        startAt: body.startAt,
        endAt: body.endAt,
        signedUp: false,
      };
      events.splice(0, events.length, created);
      await route.fulfill({ status: 201, json: created });
      return;
    }
    if (url.pathname.endsWith('/signup') && method === 'POST') {
      const raw = route.request().postData();
      if (raw) {
        hourPayloads.push(JSON.parse(raw) as { attendees: { memberId: string; hours: number }[] });
      } else {
        const current = events[0];
        if (current) events.splice(0, events.length, { ...current, signedUp: true });
      }
      await route.fulfill({ json: { eventId: 'evt-drill-1' } });
      return;
    }
    await route.fulfill({ status: 404, json: {} });
  });

  await signInAs(page, ['TRAINING']);
  await page.goto('/training/events');
  await expect(page.getByRole('heading', { name: 'Training events' })).toBeVisible();

  await page.getByLabel('Title').fill('Hose line drill');
  await page.getByLabel('Category').fill('Drill');
  await page.getByLabel('Starts').fill('2020-06-01T18:00');
  await page.getByLabel('Ends').fill('2020-06-01T20:00');
  await page.getByRole('button', { name: 'Create event' }).click();

  await expect(page.getByText('Hose line drill')).toBeVisible();
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByText('Signed up')).toBeVisible();

  const hoursForm = page.getByRole('form', { name: 'Record hours for Hose line drill' });
  await hoursForm.getByLabel('Member ID').fill('m-2');
  await hoursForm.getByLabel('Hours').fill('2');
  await hoursForm.getByRole('button', { name: 'Record hours' }).click();

  await expect.poll(() => hourPayloads.length).toBe(1);
  expect(hourPayloads[0]).toEqual({ attendees: [{ memberId: 'm-2', hours: 2 }] });

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
