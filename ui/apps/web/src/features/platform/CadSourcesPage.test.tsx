import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { RequireRole } from '../../routing/RequireRole';
import { CadSourcesPage } from './CadSourcesPage';
import type { CadSourcesResponse } from './types';

// Radix Checkbox measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  cleanup();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function makeManager(groups: string[]): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile: { sub: 'chief-1', 'cognito:groups': groups },
  } as unknown as User;
  return {
    getUser: vi.fn(async () => user),
    events: {
      addUserLoaded: () => undefined,
      removeUserLoaded: () => undefined,
      addUserUnloaded: () => undefined,
      removeUserUnloaded: () => undefined,
      addSilentRenewError: () => undefined,
      removeSilentRenewError: () => undefined,
    },
  } as unknown as UserManager;
}

function renderPage(groups: string[] = ['CHIEF']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={['/settings/cad-sources']}>
          <Routes>
            <Route
              path="/settings/cad-sources"
              element={
                <RequireRole>
                  <CadSourcesPage />
                </RequireRole>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

const STORED: CadSourcesResponse = {
  version: 3,
  emailDomain: 'cad.nichols.example.org',
  webhookUrl: 'https://cad.example.org/api/v1/alerting/ingress/cad-webhook',
  sources: [
    {
      sourceId: 'county',
      label: 'County CAD',
      enabled: true,
      emailEnabled: true,
      allowedSenders: ['cad.county.gov'],
      emailAddress: 'dispatch+nichols-fd.county.abcdefghijklmnop@cad.nichols.example.org',
      webhookEnabled: true,
      webhookKeyId: 'nichols-fd.county',
      webhookRotatedAt: '2026-09-30T12:00:00.000Z',
      parser: { version: 2, fields: { address: { label: 'ADDR' } } },
    },
  ],
};

test('CHIEF sees the saved source, its email address and parser version', async () => {
  server.use(http.get('/api/v1/platform/cad-sources', () => HttpResponse.json(STORED)));
  renderPage();
  expect(await screen.findByRole('heading', { name: 'County CAD' })).toBeTruthy();
  expect(screen.getByText(STORED.sources[0]!.emailAddress!)).toBeTruthy();
  expect(screen.getByText('Parser template (version 2)')).toBeTruthy();
  expect(screen.getByLabelText('Source id').hasAttribute('readonly')).toBe(true);
  expect((screen.getByLabelText('Allowed senders') as HTMLTextAreaElement).value).toBe(
    'cad.county.gov',
  );
});

test('warns when a source reads no incident number, and not once it does', async () => {
  server.use(http.get('/api/v1/platform/cad-sources', () => HttpResponse.json(STORED)));
  renderPage();
  await screen.findByRole('heading', { name: 'County CAD' });
  expect(screen.getByRole('note').textContent).toContain('no incident number rule');
  fireEvent.change(screen.getByLabelText('Incident number: read by'), {
    target: { value: 'label' },
  });
  fireEvent.change(screen.getByLabelText('Incident number: label'), { target: { value: 'INC' } });
  expect(screen.queryByRole('note')).toBeNull();
});

test('a member without CHIEF/ADMIN cannot open the page', async () => {
  server.use(http.get('/api/v1/platform/cad-sources', () => HttpResponse.json(STORED)));
  renderPage(['OFFICER']);
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'County CAD' })).toBeNull());
});

test('saving sends every source with the loaded version and the senders one per line', async () => {
  let body: unknown;
  server.use(
    http.get('/api/v1/platform/cad-sources', () => HttpResponse.json(STORED)),
    http.put('/api/v1/platform/cad-sources', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ ...STORED, version: 4 });
    }),
  );
  const user = userEvent.setup();
  renderPage();
  const senders = await screen.findByLabelText('Allowed senders');
  fireEvent.change(senders, { target: { value: 'cad.county.gov\ndispatch@backup.county.gov' } });
  await user.click(screen.getByRole('button', { name: 'Save CAD sources' }));
  expect((await screen.findByText(/CAD sources saved/)).getAttribute('role')).toBe('status');
  expect(body).toEqual({
    expectedVersion: 3,
    sources: [
      {
        sourceId: 'county',
        label: 'County CAD',
        enabled: true,
        emailEnabled: true,
        allowedSenders: ['cad.county.gov', 'dispatch@backup.county.gov'],
        webhookEnabled: true,
        parser: { fields: { address: { label: 'ADDR' } } },
      },
    ],
  });
});

test('a rejected save lists the field errors', async () => {
  server.use(
    http.get('/api/v1/platform/cad-sources', () => HttpResponse.json(STORED)),
    http.put('/api/v1/platform/cad-sources', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          traceId: 't',
          errors: [
            {
              field: 'sources[0].parser.fields.address.pattern',
              detail: 'is not a valid regular expression',
            },
          ],
        },
        { status: 400 },
      ),
    ),
  );
  const user = userEvent.setup();
  renderPage();
  await screen.findByRole('heading', { name: 'County CAD' });
  await user.click(screen.getByRole('button', { name: 'Save CAD sources' }));
  const alert = await screen.findByText('The CAD sources were not saved.');
  expect(alert.closest('[role="alert"]')?.textContent).toContain(
    'is not a valid regular expression',
  );
});

test('test parse previews a structured dispatch, and the fail-open raw page', async () => {
  let sent: unknown;
  server.use(
    http.get('/api/v1/platform/cad-sources', () => HttpResponse.json(STORED)),
    http.post('/api/v1/platform/cad-sources/test-parse', async ({ request }) => {
      sent = await request.json();
      const { sample } = sent as { sample: string };
      return HttpResponse.json(
        sample.includes('ADDR')
          ? { status: 'PARSED', fields: { address: '1 MAIN ST' } }
          : { status: 'RAW', reason: 'NO_ADDRESS', fields: {} },
      );
    }),
  );
  const user = userEvent.setup();
  renderPage();
  const sample = await screen.findByLabelText('Sample dispatch text');
  fireEvent.change(sample, { target: { value: 'ADDR: 1 MAIN ST' } });
  await user.click(screen.getByRole('button', { name: 'Test parse' }));
  const status = await screen.findByText(/Structured\./);
  expect(status.closest('[role="status"]')?.textContent).toContain('1 MAIN ST');
  expect(sent).toEqual({ fields: { address: { label: 'ADDR' } }, sample: 'ADDR: 1 MAIN ST' });

  fireEvent.change(sample, { target: { value: 'garbled' } });
  await user.click(screen.getByRole('button', { name: 'Test parse' }));
  expect((await screen.findByText(/Raw text \(VERIFY\)\./)).closest('p')?.textContent).toContain(
    'the template did not find the address',
  );
});

test('rotating the webhook key shows the new key once, then never again', async () => {
  server.use(
    http.get('/api/v1/platform/cad-sources', () => HttpResponse.json(STORED)),
    http.post('/api/v1/platform/cad-sources/county/webhook-key', () =>
      HttpResponse.json({
        keyId: 'nichols-fd.county',
        secret: 'f'.repeat(64),
        apiKey: 'A'.repeat(32),
        rotatedAt: '2026-09-30T13:00:00.000Z',
        previousKeyStillValid: true,
        previousKeyExpiresAt: '2026-10-01T13:00:00.000Z',
        webhookUrl: STORED.webhookUrl,
      }),
    ),
  );
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Rotate webhook key' }));
  const confirm = await screen.findByRole('dialog');
  await user.click(within(confirm).getByRole('button', { name: 'Rotate key' }));
  const shown = await screen.findByRole('dialog', { name: 'Copy the webhook key now' });
  expect(within(shown).getByText('f'.repeat(64))).toBeTruthy();
  expect(within(shown).getByText('A'.repeat(32))).toBeTruthy();
  await user.click(within(shown).getByRole('button', { name: 'I have stored the key' }));
  await waitFor(() => expect(screen.queryByText('f'.repeat(64))).toBeNull());
});

test('the one-time key dialog copies each value and a paste-ready vendor block', async () => {
  server.use(
    http.get('/api/v1/platform/cad-sources', () => HttpResponse.json(STORED)),
    http.post('/api/v1/platform/cad-sources/county/webhook-key', () =>
      HttpResponse.json({
        keyId: 'nichols-fd.county',
        secret: 'f'.repeat(64),
        apiKey: 'A'.repeat(32),
        rotatedAt: '2026-09-30T13:00:00.000Z',
        previousKeyStillValid: true,
        previousKeyExpiresAt: '2026-10-01T13:00:00.000Z',
        webhookUrl: STORED.webhookUrl,
      }),
    ),
  );
  const user = userEvent.setup(); // installs a working clipboard stub in jsdom
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Rotate webhook key' }));
  const confirm = await screen.findByRole('dialog');
  await user.click(within(confirm).getByRole('button', { name: 'Rotate key' }));
  const shown = await screen.findByRole('dialog', { name: 'Copy the webhook key now' });

  await user.click(within(shown).getByRole('button', { name: 'Copy key' }));
  expect(await within(shown).findByText('Copied.')).toBeTruthy();
  expect(await navigator.clipboard.readText()).toBe('f'.repeat(64));
  expect(within(shown).getByRole('button', { name: 'Copy x-api-key' })).toBeTruthy();
  expect(within(shown).getByRole('button', { name: 'Copy address' })).toBeTruthy();

  // The vendor block carries the whole contract: URL, headers, key, body, retries, warning.
  await user.click(within(shown).getByRole('button', { name: 'Copy set-up instructions' }));
  const block = await navigator.clipboard.readText();
  expect(block).toContain(`POST ${STORED.webhookUrl}`);
  expect(block).toContain('f'.repeat(64));
  expect(block).toContain(`x-api-key: ${'A'.repeat(32)}`);
  expect(block).toContain('X-Boxalarm-Source: nichols-fd.county');
  expect(block).toContain('UTF-8 JSON');
  expect(block).toContain(
    'retry a 429 and any 5xx with back-off, signed again with a fresh timestamp',
  );
  expect(block).toContain('Never retry 401, 403 or 409');
  expect(block).toContain('202 {"status":"accepted"} or 200 {"status":"duplicate"}');
  expect(block).toContain('pages every eligible member');

  // The pages-everyone warning is also visible in the dialog itself.
  expect(within(shown).getByRole('note').textContent).toContain('pages every eligible member');
});

test('a new source is added with every field labelled', async () => {
  server.use(
    http.get('/api/v1/platform/cad-sources', () =>
      HttpResponse.json({ ...STORED, version: null, sources: [] }),
    ),
  );
  const user = userEvent.setup();
  renderPage(['ADMIN']);
  expect(await screen.findByText('No CAD sources yet.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Add CAD source' }));
  expect(screen.getByLabelText('Source id').hasAttribute('readonly')).toBe(false);
  expect(screen.getByText('Save the source to create its key.')).toBeTruthy();
  // Every parser field has a labelled mode and value control.
  expect(screen.getAllByRole('combobox')).toHaveLength(8);
  expect(screen.getByLabelText('Address (required): read by')).toBeTruthy();
});

test('revoking the previous key is confirmed first and then reported', async () => {
  let revoked = false;
  server.use(
    http.get('/api/v1/platform/cad-sources', () => HttpResponse.json(STORED)),
    http.post('/api/v1/platform/cad-sources/county/webhook-key/revoke-previous', () => {
      revoked = true;
      return HttpResponse.json({ sourceId: 'county', previousKeyRevoked: true });
    }),
  );
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Revoke previous key now' }));
  expect(revoked).toBe(false);
  const confirm = await screen.findByRole('dialog');
  await user.click(within(confirm).getByRole('button', { name: 'Revoke previous key' }));
  expect((await screen.findByText('The previous key no longer works.')).getAttribute('role')).toBe(
    'status',
  );
  expect(revoked).toBe(true);
});

test('a new email address is confirmed first and then shown', async () => {
  server.use(
    http.get('/api/v1/platform/cad-sources', () => HttpResponse.json(STORED)),
    http.post('/api/v1/platform/cad-sources/county/email-address', () =>
      HttpResponse.json({
        ...STORED,
        version: 4,
        sources: [
          {
            ...STORED.sources[0]!,
            emailAddress: 'dispatch+nichols-fd.county.zzzzzzzzzzzzzzzz@cad.nichols.example.org',
          },
        ],
      }),
    ),
  );
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'New email address' }));
  const confirm = await screen.findByRole('dialog');
  await user.click(within(confirm).getByRole('button', { name: 'New address' }));
  expect(
    await screen.findByText('dispatch+nichols-fd.county.zzzzzzzzzzzzzzzz@cad.nichols.example.org'),
  ).toBeTruthy();
});

test("test parse sends the draft's CAD time zone and names the zone that resolved the time", async () => {
  let sent: unknown;
  server.use(
    http.get('/api/v1/platform/cad-sources', () => HttpResponse.json(STORED)),
    http.post('/api/v1/platform/cad-sources/test-parse', async ({ request }) => {
      sent = await request.json();
      return HttpResponse.json({
        status: 'PARSED',
        fields: { address: '1 MAIN ST', dispatchTime: '01:10' },
        dispatchTimeResolved: '2026-10-01T06:10:00.000Z',
      });
    }),
  );
  const user = userEvent.setup();
  renderPage();
  fireEvent.change(await screen.findByLabelText('CAD time zone'), {
    target: { value: 'America/Chicago' },
  });
  fireEvent.change(screen.getByLabelText('Sample dispatch text'), {
    target: { value: 'ADDR: 1 MAIN ST\nTIME: 01:10' },
  });
  await user.click(screen.getByRole('button', { name: 'Test parse' }));

  expect(await screen.findByText(/in America\/Chicago/)).toBeTruthy();
  expect(sent).toMatchObject({ timeZone: 'America/Chicago' });

  // Changing the zone drops the stale preview - its resolved time no longer applies.
  fireEvent.change(screen.getByLabelText('CAD time zone'), {
    target: { value: 'America/Denver' },
  });
  await waitFor(() => expect(screen.queryByText(/Dispatch time read as/)).toBeNull());
});

test('test parse says when the dispatch time cannot be ordered by', async () => {
  server.use(
    http.get('/api/v1/platform/cad-sources', () => HttpResponse.json(STORED)),
    http.post('/api/v1/platform/cad-sources/test-parse', () =>
      HttpResponse.json({
        status: 'PARSED',
        fields: { address: '1 MAIN ST', dispatchTime: 'TUESDAY' },
        dispatchTimeUnordered: true,
      }),
    ),
  );
  const user = userEvent.setup();
  renderPage();
  fireEvent.change(await screen.findByLabelText('Sample dispatch text'), {
    target: { value: 'ADDR: 1 MAIN ST' },
  });
  await user.click(screen.getByRole('button', { name: 'Test parse' }));
  expect(await screen.findByText(/applied in the order they\s+arrive/)).toBeTruthy();
});
