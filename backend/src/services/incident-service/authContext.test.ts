import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventHeaders } from 'aws-lambda';
import { problemResponse, readAuthorizerContext, resolveTraceId } from './authContext.js';
import type { IncidentEvent } from './authContext.js';

function buildEvent(lambdaContext: Record<string, unknown> | undefined): IncidentEvent {
  return {
    requestContext: {
      authorizer: lambdaContext !== undefined ? { lambda: lambdaContext } : undefined,
    },
  } as unknown as IncidentEvent;
}

describe('resolveTraceId (regression for PR #149 finding 3)', () => {
  it('extracts the trace-id segment from a W3C traceparent header', () => {
    const headers: APIGatewayProxyEventHeaders = {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    };

    expect(resolveTraceId(headers, 'fallback-id')).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('is case-insensitive on the header name', () => {
    const headers: APIGatewayProxyEventHeaders = {
      Traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    };

    expect(resolveTraceId(headers, 'fallback-id')).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('falls back when no traceparent header is present', () => {
    expect(resolveTraceId({}, 'fallback-id')).toBe('fallback-id');
  });

  it('falls back when the traceparent header is malformed', () => {
    expect(resolveTraceId({ traceparent: 'garbage' }, 'fallback-id')).toBe('fallback-id');
  });
});

describe('readAuthorizerContext', () => {
  const BASE = { deptId: 'NICHOLS', sub: 'MBR-0034', 'cognito:groups': 'ADMIN' };

  it('returns deptId, sub, and isAdmin for a well-formed context', () => {
    const result = readAuthorizerContext(buildEvent(BASE));

    expect(result.deptId).toBe('NICHOLS');
    expect(result.sub).toBe('MBR-0034');
    expect(result.isAdmin).toBe(true);
  });

  it('throws when deptId is missing', () => {
    const rest = Object.fromEntries(Object.entries(BASE).filter(([key]) => key !== 'deptId'));
    expect(() => readAuthorizerContext(buildEvent(rest))).toThrow(/deptId/);
  });

  it('throws (fails closed) when sub is missing, rather than defaulting to an empty string (regression for PR #149 finding 4)', () => {
    const rest = Object.fromEntries(Object.entries(BASE).filter(([key]) => key !== 'sub'));
    expect(() => readAuthorizerContext(buildEvent(rest))).toThrow(/sub/);
  });

  it('throws (fails closed) when sub is an empty string', () => {
    expect(() => readAuthorizerContext(buildEvent({ ...BASE, sub: '' }))).toThrow(/sub/);
  });

  it('throws when the authorizer context is absent entirely', () => {
    expect(() => readAuthorizerContext(buildEvent(undefined))).toThrow();
  });
});

describe('problemResponse', () => {
  it('builds an RFC 7807 problem+json body carrying the traceId', () => {
    const response = problemResponse(404, 'Not Found', 'missing', 'trace-1');
    expect(response.statusCode).toBe(404);
    expect(response.headers['Content-Type']).toBe('application/problem+json');
    expect(JSON.parse(response.body)).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'missing',
      traceId: 'trace-1',
    });
  });

  it('merges extension members such as per-field errors', () => {
    const errors = [{ field: 'incident_type', message: 'not in enumeration' }];
    const body = JSON.parse(
      problemResponse(400, 'Bad Request', 'invalid', 'trace-1', { errors }).body,
    ) as Record<string, unknown>;
    expect(body.errors).toEqual(errors);
    expect(body.status).toBe(400);
  });

  it('never lets an extension override a standard member', () => {
    const body = JSON.parse(
      problemResponse(400, 'Bad Request', 'invalid', 'trace-1', { status: 200, traceId: 'x' }).body,
    ) as Record<string, unknown>;
    expect(body.status).toBe(400);
    expect(body.traceId).toBe('trace-1');
  });
});
