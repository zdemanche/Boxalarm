import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { ApiError } from '../lib/apiClient';
import { ApiForbiddenGate } from './ApiForbiddenGate';

afterEach(cleanup);

test('renders ForbiddenState with a fixed generic message for API 403 (server detail/traceId not shown)', () => {
  const error = new ApiError({
    type: 'about:blank',
    title: 'Forbidden',
    status: 403,
    detail: 'Cedar denied apparatus:create',
    traceId: 'abc-123',
  });

  render(
    <ApiForbiddenGate error={error}>
      <p>secret content</p>
    </ApiForbiddenGate>,
  );

  expect(screen.getByRole('heading', { name: 'Forbidden' })).toBeTruthy();
  expect(screen.getByText('You do not have access to this page.')).toBeTruthy();
  // The raw Cedar detail and traceId must not leak into the rendered DOM.
  expect(screen.queryByText('Cedar denied apparatus:create')).toBeNull();
  expect(screen.queryByText('abc-123')).toBeNull();
  expect(screen.queryByText('secret content')).toBeNull();
});

test('renders children when there is no error', () => {
  render(
    <ApiForbiddenGate error={null}>
      <p>ok</p>
    </ApiForbiddenGate>,
  );
  expect(screen.getByText('ok')).toBeTruthy();
});

test('renders a generic retryable error state for non-403 API errors instead of throwing', () => {
  // Regression: this used to throw and bubble to ConfigErrorBoundary, which showed the
  // unrecoverable "Boxalarm can't start / sign-in configuration" message for ANY error,
  // including a transient backend 500 or an offline fetch rejection.
  const error = new ApiError({
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    detail: 'Missing',
    traceId: 'nope',
  });

  render(
    <ApiForbiddenGate error={error}>
      <p>secret</p>
    </ApiForbiddenGate>,
  );

  expect(
    screen.getByRole('heading', { name: 'Something went wrong loading this page' }),
  ).toBeTruthy();
  expect(screen.queryByText(/can't start/i)).toBeNull();
  expect(screen.queryByText(/sign-in configuration/i)).toBeNull();
  expect(screen.queryByText('secret')).toBeNull();
});

test('renders a generic retryable error state for a non-ApiError too (e.g. an offline fetch rejection)', () => {
  render(
    <ApiForbiddenGate error={new TypeError('Failed to fetch')}>
      <p>secret</p>
    </ApiForbiddenGate>,
  );

  expect(
    screen.getByRole('heading', { name: 'Something went wrong loading this page' }),
  ).toBeTruthy();
  expect(screen.queryByText('secret')).toBeNull();
});
