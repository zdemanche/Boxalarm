import type { ProblemResponse } from '@boxalarm/authz';

function problemResponse(
  status: number,
  type: string,
  title: string,
  detail: string,
  traceId: string,
): ProblemResponse {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({ type, title, status, detail, traceId }),
  };
}

export function validationProblem(traceId: string, detail: string): ProblemResponse {
  return problemResponse(
    400,
    'https://boxalarm.dev/problems/validation-error',
    'Validation Error',
    detail,
    traceId,
  );
}

export function conflictProblem(traceId: string, detail: string): ProblemResponse {
  return problemResponse(
    409,
    'https://boxalarm.dev/problems/conflict',
    'Conflict',
    detail,
    traceId,
  );
}
