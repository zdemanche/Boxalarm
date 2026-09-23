import { describe, expect, it } from 'vitest';
import {
  badRequestProblem,
  dependencyUnavailableProblem,
  forbiddenProblem,
  notFoundProblem,
  serviceUnavailableProblem,
  tooManyRequestsProblem,
} from './problemDetails.js';

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

describe('dependencyUnavailableProblem', () => {
  it('returns a 503 RFC 7807 body distinct from serviceUnavailableProblem', () => {
    const response = dependencyUnavailableProblem('trace-dep');
    expect(response.statusCode).toBe(503);
    expect(response.headers).toEqual({ 'content-type': 'application/problem+json' });
    const body = JSON.parse(response.body) as {
      status: number;
      traceId: string;
      type: string;
      title: string;
      detail: string;
    };
    expect(body.status).toBe(503);
    expect(body.traceId).toBe('trace-dep');
    expect(body.type).toBe('https://boxalarm.dev/problems/dependency-unavailable');
    expect(body.title).toBe('Dependency Unavailable');
    expect(body.detail).toBe('A required upstream dependency is temporarily unavailable.');
  });
});

describe('notFoundProblem', () => {
  it('returns a 404 RFC 7807 body carrying the traceId and given detail', () => {
    const response = notFoundProblem('trace-404', 'No apparatus found for unitId "ENGINE-9"');
    expect(response.statusCode).toBe(404);
    expect(response.headers).toEqual({ 'content-type': 'application/problem+json' });
    const body = JSON.parse(response.body) as { status: number; traceId: string; detail: string };
    expect(body.status).toBe(404);
    expect(body.traceId).toBe('trace-404');
    expect(body.detail).toBe('No apparatus found for unitId "ENGINE-9"');
  });
});

describe('tooManyRequestsProblem', () => {
  it('returns a 429 RFC 7807 body carrying the traceId and given detail', () => {
    const response = tooManyRequestsProblem('trace-429', 'self-test cooldown active');
    expect(response.statusCode).toBe(429);
    expect(response.headers).toEqual({ 'content-type': 'application/problem+json' });
    const body = JSON.parse(response.body) as { status: number; traceId: string; detail: string };
    expect(body.status).toBe(429);
    expect(body.traceId).toBe('trace-429');
    expect(body.detail).toBe('self-test cooldown active');
  });
});

describe('badRequestProblem', () => {
  it('returns a 400 RFC 7807 body carrying the traceId and given detail', () => {
    const response = badRequestProblem('trace-400', 'unitId path parameter is required');
    expect(response.statusCode).toBe(400);
    expect(response.headers).toEqual({ 'content-type': 'application/problem+json' });
    const body = JSON.parse(response.body) as { status: number; traceId: string; detail: string };
    expect(body.status).toBe(400);
    expect(body.traceId).toBe('trace-400');
    expect(body.detail).toBe('unitId path parameter is required');
  });

  it('returns a 400 body with field errors when given a FieldError list', () => {
    const response = badRequestProblem('trace-400', [
      { field: 'maxLng', detail: 'maxLng is required' },
    ]);
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as {
      status: number;
      traceId: string;
      errors: { field: string; detail: string }[];
    };
    expect(body.status).toBe(400);
    expect(body.traceId).toBe('trace-400');
    expect(body.errors.map((e) => e.field)).toEqual(['maxLng']);
  });
});
