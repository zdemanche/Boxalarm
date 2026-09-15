import { describe, expect, it } from 'vitest';
import {
  badRequestProblem,
  conflictProblem,
  internalErrorProblem,
  notFoundProblem,
} from './problemDetails.js';

describe('conflictProblem', () => {
  it('returns a 409 RFC 7807 application/problem+json body with a stable type literal', () => {
    const response = conflictProblem('trace-1');
    expect(response.statusCode).toBe(409);
    expect(response.headers).toEqual({ 'content-type': 'application/problem+json' });
    const body = JSON.parse(response.body) as { status: number; traceId: string; type: string };
    expect(body.status).toBe(409);
    expect(body.traceId).toBe('trace-1');
    expect(body.type).toBe('https://boxalarm.dev/problems/shift-position-conflict');
  });
});

describe('notFoundProblem', () => {
  it('returns a 404 RFC 7807 application/problem+json body', () => {
    const response = notFoundProblem('trace-2');
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body) as { status: number; traceId: string };
    expect(body.status).toBe(404);
    expect(body.traceId).toBe('trace-2');
  });
});

describe('badRequestProblem', () => {
  it('returns a 400 RFC 7807 application/problem+json body carrying the detail message', () => {
    const response = badRequestProblem('trace-3', 'positionCode is required');
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { status: number; detail: string };
    expect(body.status).toBe(400);
    expect(body.detail).toBe('positionCode is required');
  });
});

describe('internalErrorProblem', () => {
  it('returns a 500 RFC 7807 application/problem+json body', () => {
    const response = internalErrorProblem('trace-4');
    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body) as { status: number; traceId: string };
    expect(body.status).toBe(500);
    expect(body.traceId).toBe('trace-4');
  });
});
