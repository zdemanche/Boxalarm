import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export interface ProblemDetailsFieldError {
  readonly field: string;
  readonly message: string;
}

export interface ProblemDetailsBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly traceId: string;
  readonly errors?: readonly ProblemDetailsFieldError[];
}

export function toProblemResponse(
  status: number,
  title: string,
  detail: string,
  traceId: string,
  errors?: readonly ProblemDetailsFieldError[],
): APIGatewayProxyStructuredResultV2 {
  const body: ProblemDetailsBody = {
    type: 'about:blank',
    title,
    status,
    detail,
    traceId,
    ...(errors ? { errors } : {}),
  };
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify(body),
  };
}
