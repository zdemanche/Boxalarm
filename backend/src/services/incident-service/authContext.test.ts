import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventHeaders } from 'aws-lambda';
import { readAuthorizerContext, resolveTraceId } from './authContext.js';
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
