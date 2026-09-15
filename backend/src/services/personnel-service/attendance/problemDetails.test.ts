import { describe, expect, it } from 'vitest';
import { conflictProblem, validationProblem } from './problemDetails.js';

describe('validationProblem', () => {
  it('returns a 400 RFC 7807 body carrying the traceId and detail', () => {
    const result = validationProblem('trace-1', 'activityType must be one of the allowed values.');
    expect(result.statusCode).toBe(400);
    expect(result.headers['content-type']).toBe('application/problem+json');
    expect(JSON.parse(result.body)).toEqual({
      type: 'https://boxalarm.dev/problems/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: 'activityType must be one of the allowed values.',
      traceId: 'trace-1',
    });
  });
});

describe('conflictProblem', () => {
  it('returns a 409 RFC 7807 body carrying the traceId and detail', () => {
    const result = conflictProblem(
      'trace-2',
      'An attendance record already exists for this member.',
    );
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({
      type: 'https://boxalarm.dev/problems/conflict',
      title: 'Conflict',
      status: 409,
      detail: 'An attendance record already exists for this member.',
      traceId: 'trace-2',
    });
  });
});
