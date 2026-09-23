import { describe, expect, it } from 'vitest';
import { unauthorizedVendorProblem, verifyVendorSecret } from './vendorAuth.js';

describe('verifyVendorSecret', () => {
  it('returns true for a matching secret', () => {
    expect(verifyVendorSecret('shared-secret', 'shared-secret')).toBe(true);
  });

  it('returns false for a missing provided secret', () => {
    expect(verifyVendorSecret(undefined, 'shared-secret')).toBe(false);
  });

  it('returns false (never throws) for a provided secret of a different length than expected', () => {
    expect(() => verifyVendorSecret('short', 'a-much-longer-expected-secret')).not.toThrow();
    expect(verifyVendorSecret('short', 'a-much-longer-expected-secret')).toBe(false);
  });
});

describe('unauthorizedVendorProblem', () => {
  it('builds a 401 problem+json body', () => {
    const result = unauthorizedVendorProblem('trace-1', 'bad secret') as {
      statusCode: number;
      headers: Record<string, string>;
      body: string;
    };
    expect(result.statusCode).toBe(401);
    expect(result.headers['content-type']).toBe('application/problem+json');
    expect(JSON.parse(result.body)).toMatchObject({
      status: 401,
      traceId: 'trace-1',
      detail: 'bad secret',
    });
  });
});
