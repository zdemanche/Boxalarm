import { describe, expect, it } from 'vitest';
import {
  badRequestProblem,
  forbiddenProblem,
  notFoundProblem,
  serviceUnavailableProblem,
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
});
