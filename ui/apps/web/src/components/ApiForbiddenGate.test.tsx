import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { ApiError } from '../lib/apiClient';
import { ApiForbiddenGate } from './ApiForbiddenGate';

afterEach(cleanup);

test('renders ForbiddenState with detail and traceId for API 403', () => {
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
  expect(screen.getByText('Cedar denied apparatus:create')).toBeTruthy();
  expect(screen.getByText('abc-123')).toBeTruthy();
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

test('rethrows non-403 ApiErrors so callers can handle them', () => {
  const error = new ApiError({
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    detail: 'Missing',
    traceId: 'nope',
  });

  expect(() =>
    render(
      <ApiForbiddenGate error={error}>
        <p>secret</p>
      </ApiForbiddenGate>,
    ),
  ).toThrow(error);
});
