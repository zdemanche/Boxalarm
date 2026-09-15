import { describe, expect, it } from 'vitest';
import { problemResponse } from './errorResponse.js';

describe('problemResponse (RFC 7807)', () => {
  it('shapes a 400 with field-level errors', () => {
    const response = problemResponse({
      status: 400,
      title: 'Invalid dispatch payload',
      traceId: 'trace-1',
      errors: [{ field: 'address', message: 'address is required and must be a non-empty string' }],
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers).toEqual({ 'content-type': 'application/problem+json' });
    expect(JSON.parse(response.body as string)).toEqual({
      type: 'about:blank',
      title: 'Invalid dispatch payload',
      status: 400,
      traceId: 'trace-1',
      errors: [{ field: 'address', message: 'address is required and must be a non-empty string' }],
    });
  });

  it('shapes a 403 with no errors array when none is given', () => {
    const response = problemResponse({ status: 403, title: 'Forbidden', traceId: 'trace-2' });
    const parsed = JSON.parse(response.body as string) as Record<string, unknown>;
    expect(response.statusCode).toBe(403);
    expect(parsed).not.toHaveProperty('errors');
    expect(parsed.traceId).toBe('trace-2');
  });

  it('shapes a 409 duplicate-submission response', () => {
    const response = problemResponse({
      status: 409,
      title: 'Duplicate dispatch submission',
      traceId: 'trace-3',
    });
    expect(response.statusCode).toBe(409);
  });

  it('shapes a 503 service-unavailable response', () => {
    const response = problemResponse({
      status: 503,
      title: 'Service unavailable',
      traceId: 'trace-4',
    });
    expect(response.statusCode).toBe(503);
  });
});
