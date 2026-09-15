import { describe, expect, it } from 'vitest';
import {
  badRequestProblem,
  duplicateSignupProblem,
  eventNotFoundProblem,
  signupAfterEventStartedProblem,
} from './problemDetails.js';

describe('training-service problem details', () => {
  it('badRequestProblem returns a 400 RFC 7807 body carrying the given detail and traceId', () => {
    const response = badRequestProblem('trace-1', 'title is required');
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toBe('application/problem+json');
    expect(JSON.parse(response.body)).toMatchObject({
      status: 400,
      detail: 'title is required',
      traceId: 'trace-1',
    });
  });

  it('eventNotFoundProblem returns a 404 RFC 7807 body', () => {
    const response = eventNotFoundProblem('trace-2');
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({ status: 404, traceId: 'trace-2' });
  });

  it('signupAfterEventStartedProblem returns a 422 RFC 7807 body', () => {
    const response = signupAfterEventStartedProblem('trace-3');
    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body)).toMatchObject({ status: 422, traceId: 'trace-3' });
  });

  it('duplicateSignupProblem returns a 409 RFC 7807 body', () => {
    const response = duplicateSignupProblem('trace-4');
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ status: 409, traceId: 'trace-4' });
  });
});
