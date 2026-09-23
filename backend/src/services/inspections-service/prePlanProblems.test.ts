import { describe, expect, it } from 'vitest';
import {
  dependencyUnavailableProblem,
  invalidRequestProblem,
  notFoundProblem,
  type ProblemDetailsBody,
} from './prePlanProblems.js';

function parseBody(body: string): ProblemDetailsBody {
  return JSON.parse(body) as ProblemDetailsBody;
}

describe('prePlanProblems', () => {
  it('builds a 404 RFC 7807 body for notFoundProblem', () => {
    const response = notFoundProblem('no pre-plan on file', 'trace-1');
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toBe('application/problem+json');
    expect(parseBody(response.body)).toEqual({
      type: 'https://boxalarm.dev/problems/not-found',
      title: 'Not Found',
      status: 404,
      detail: 'no pre-plan on file',
      traceId: 'trace-1',
    });
  });

  it('builds a 400 RFC 7807 body for invalidRequestProblem', () => {
    const response = invalidRequestProblem('bad body', 'trace-2');
    expect(response.statusCode).toBe(400);
    expect(parseBody(response.body).type).toBe('https://boxalarm.dev/problems/invalid-request');
  });

  it('builds a 503 RFC 7807 body for dependencyUnavailableProblem', () => {
    const response = dependencyUnavailableProblem('trace-3');
    expect(response.statusCode).toBe(503);
    expect(parseBody(response.body).type).toBe(
      'https://boxalarm.dev/problems/dependency-unavailable',
    );
  });
});
