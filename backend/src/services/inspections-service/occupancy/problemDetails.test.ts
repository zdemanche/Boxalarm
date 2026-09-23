import { describe, expect, it } from 'vitest';
import { toProblemResponse } from './problemDetails.js';

describe('toProblemResponse', () => {
  it('builds an RFC 7807 problem+json body with the given status/title/detail/traceId', () => {
    const result = toProblemResponse(400, 'Invalid Occupancy', 'bad input', 'trace-1');
    expect(result.statusCode).toBe(400);
    expect(result.headers).toEqual({ 'content-type': 'application/problem+json' });
    expect(JSON.parse(result.body as string)).toEqual({
      type: 'about:blank',
      title: 'Invalid Occupancy',
      status: 400,
      detail: 'bad input',
      traceId: 'trace-1',
    });
  });

  it('includes a field-level errors array when provided', () => {
    const result = toProblemResponse(400, 'Invalid Occupancy', 'bad input', 'trace-1', [
      { field: 'address', message: 'must be a non-empty string' },
    ]);
    const body = JSON.parse(result.body as string) as { errors: unknown };
    expect(body.errors).toEqual([{ field: 'address', message: 'must be a non-empty string' }]);
  });

  it('omits the errors key entirely when none are given', () => {
    const result = toProblemResponse(503, 'Service Unavailable', 'try later', 'trace-2');
    const body = JSON.parse(result.body as string) as Record<string, unknown>;
    expect('errors' in body).toBe(false);
  });
});
