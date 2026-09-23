import type { APIGatewayProxyEventHeaders, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly traceId: string;
}

export function problemResponse(
  status: number,
  title: string,
  detail: string,
  traceId: string,
): APIGatewayProxyStructuredResultV2 {
  const body: ProblemDetails = { type: 'about:blank', title, status, detail, traceId };
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify(body),
  };
}

export function resolveTraceId(headers: APIGatewayProxyEventHeaders, fallback: string): string {
  const traceparent = headers.traceparent ?? headers.Traceparent;
  if (traceparent) {
    const parts = traceparent.split('-');
    if (parts.length === 4 && parts[1]) {
      return parts[1];
    }
  }
  return fallback;
}
