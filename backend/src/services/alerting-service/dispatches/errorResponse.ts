import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { FieldError } from './dispatchIngressPort.js';

export interface ProblemResponseOptions {
  readonly status: number;
  readonly title: string;
  readonly traceId: string;
  readonly errors?: readonly FieldError[];
}

export function problemResponse(
  options: ProblemResponseOptions,
): APIGatewayProxyStructuredResultV2 {
  const body: Record<string, unknown> = {
    type: 'about:blank',
    title: options.title,
    status: options.status,
    traceId: options.traceId,
  };
  if (options.errors !== undefined) {
    body.errors = options.errors;
  }
  return {
    statusCode: options.status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify(body),
  };
}
