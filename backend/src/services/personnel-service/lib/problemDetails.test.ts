import { describe, expect, it } from 'vitest';
import { problemResponse, resolveTraceId } from './problemDetails.js';

describe('problemResponse', () => {
  it('builds an RFC 7807 problem-details body with the given status and traceId', () => {
    const result = problemResponse(404, 'Not Found', 'no member found', 'trace-abc');
    expect(result.statusCode).toBe(404);
    expect(result.headers).toEqual({ 'content-type': 'application/problem+json' });
    expect(JSON.parse(result.body as string)).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'no member found',
      traceId: 'trace-abc',
    });
  });
});

describe('resolveTraceId', () => {
  it('extracts the trace-id segment from a W3C traceparent header', () => {
    const traceId = resolveTraceId(
      { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
      'fallback-id',
    );
    expect(traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('falls back to the given id when no traceparent header is present', () => {
    expect(resolveTraceId({}, 'fallback-id')).toBe('fallback-id');
  });

  it('falls back when traceparent is malformed (wrong segment count)', () => {
    expect(resolveTraceId({ traceparent: 'not-a-header' }, 'fallback-id')).toBe('fallback-id');
  });
});
