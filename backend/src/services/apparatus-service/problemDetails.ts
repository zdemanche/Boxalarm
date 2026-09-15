import type { ProblemResponse } from '@boxalarm/authz';

export interface ValidationFieldError {
  readonly field: string;
  readonly message: string;
}

function problemResponse(
  status: number,
  type: string,
  title: string,
  detail: string,
  traceId: string,
  extra: Record<string, unknown> = {},
): ProblemResponse {
  const body = { type, title, status, detail, traceId, ...extra };
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify(body),
  };
}

export function apparatusNotFoundProblem(traceId: string): ProblemResponse {
  return problemResponse(
    404,
    'https://boxalarm.dev/problems/apparatus-not-found',
    'Not Found',
    'No apparatus exists for the given unit in this department.',
    traceId,
  );
}

export function validationProblem(
  traceId: string,
  errors: readonly ValidationFieldError[],
): ProblemResponse {
  return problemResponse(
    400,
    'https://boxalarm.dev/problems/validation-error',
    'Validation Error',
    'The request body failed validation.',
    traceId,
    { errors },
  );
}
