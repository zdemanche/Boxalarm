import { describe, expect, it } from 'vitest';
import { forbiddenProblem, serviceUnavailableProblem } from './problemDetails.js';

describe('forbiddenProblem', () => {
  it('returns a 403 RFC 7807 application/problem+json body carrying the traceId', () => {
    const response = forbiddenProblem('trace-abc');
    expect(response.statusCode).toBe(403);
    expect(response.headers).toEqual({ 'content-type': 'application/problem+json' });
    const body = JSON.parse(response.body) as { status: number; traceId: string; title: string };
    expect(body.status).toBe(403);
    expect(body.traceId).toBe('trace-abc');
    expect(body.title).toBe('Forbidden');
  });
});

describe('serviceUnavailableProblem', () => {
  it('returns a 503 RFC 7807 application/problem+json body carrying the traceId', () => {
    const response = serviceUnavailableProblem('trace-xyz');
    expect(response.statusCode).toBe(503);
    expect(response.headers).toEqual({ 'content-type': 'application/problem+json' });
    const body = JSON.parse(response.body) as { status: number; traceId: string; title: string };
    expect(body.status).toBe(503);
    expect(body.traceId).toBe('trace-xyz');
    expect(body.title).toBe('Service Unavailable');
  });
});
