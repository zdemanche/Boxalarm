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

export function conflictProblem(traceId: string): ProblemResponse {
  return problemResponse(
    409,
    'https://boxalarm.dev/problems/shift-position-conflict',
    'Conflict',
    'This shift position was already claimed by another member.',
    traceId,
  );
}

export function notFoundProblem(traceId: string): ProblemResponse {
  return problemResponse(
    404,
    'https://boxalarm.dev/problems/not-found',
    'Not Found',
    'The requested shift position does not exist.',
    traceId,
  );
}

export function badRequestProblem(traceId: string, detail: string): ProblemResponse {
  return problemResponse(
    400,
    'https://boxalarm.dev/problems/bad-request',
    'Bad Request',
    detail,
    traceId,
  );
}

export function internalErrorProblem(traceId: string): ProblemResponse {
  return problemResponse(
    500,
    'https://boxalarm.dev/problems/internal-error',
    'Internal Server Error',
    'An unexpected error occurred while processing the request.',
    traceId,
  );
}
