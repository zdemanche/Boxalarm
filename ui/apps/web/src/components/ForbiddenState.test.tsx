import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test } from 'vitest';
import { ForbiddenState } from './ForbiddenState';

afterEach(cleanup);

function renderAt(path: string, traceId: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ForbiddenState problem={{ title: 'Forbidden', detail: 'x', traceId }} />
    </MemoryRouter>,
  );
}

// design.md §4.7: a no-permission state says what is restricted, to whom, and who grants it.
test('a route-guard denial names the roles that can open the page and offers the dashboard', () => {
  renderAt('/settings/losap', 'route-guard');

  expect(screen.getByRole('heading', { level: 1, name: 'Forbidden' })).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toBe('You do not have access to this page.');
  expect(
    screen.getByText(/^Only the administrator can open the LOSAP settings page\. Ask the chief/),
  ).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Back to dashboard' }).getAttribute('href')).toBe('/');
});

test('roles are listed highest authority first', () => {
  renderAt('/settings/cad-sources', 'route-guard');
  expect(
    screen.getByText(/^Only the chief and administrator can open the CAD sources page\./),
  ).toBeTruthy();
});

test('an API 403 on a page the user may open never claims who could open it', () => {
  renderAt('/apparatus', 'abc-123');
  expect(screen.queryByText(/^Only the /)).toBeNull();
  expect(screen.getByText(/Ask the chief or the department administrator/)).toBeTruthy();
  expect(screen.queryByText('abc-123')).toBeNull();
});
