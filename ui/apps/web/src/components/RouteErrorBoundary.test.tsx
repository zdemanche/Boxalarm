import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { RouteErrorBoundary } from './RouteErrorBoundary';

afterEach(cleanup);

function Boom(): never {
  throw new Error('backend 500');
}

test('renders a distinct, retryable error state instead of the sign-in-config "can\'t start" message', () => {
  // React logs the caught error to console.error even though the boundary handles it — silence
  // that expected noise for this test.
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  render(
    <RouteErrorBoundary>
      <Boom />
    </RouteErrorBoundary>,
  );

  expect(
    screen.getByRole('heading', { name: 'Something went wrong loading this page' }),
  ).toBeTruthy();
  expect(screen.queryByText(/Boxalarm can't start/i)).toBeNull();
  expect(screen.queryByText(/sign-in configuration/i)).toBeNull();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();

  consoleError.mockRestore();
});

test('renders children when nothing has failed', () => {
  render(
    <RouteErrorBoundary>
      <p>page content</p>
    </RouteErrorBoundary>,
  );

  expect(screen.getByText('page content')).toBeTruthy();
});
