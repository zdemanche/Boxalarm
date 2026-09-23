import type { ProblemDetailsBody, ProblemResponse } from '@boxalarm/authz';

function problemResponse(
  status: number,
  type: string,
  title: string,
  detail: string,
  traceId: string,
): ProblemResponse {
  const body: ProblemDetailsBody = { type, title, status, detail, traceId };
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify(body),
  };
}

export function invalidPpeRequestProblem(traceId: string, detail: string): ProblemResponse {
  return problemResponse(
    400,
    'https://boxalarm.dev/problems/invalid-ppe-request',
    'Invalid PPE Request',
    detail,
    traceId,
  );
}

export function ppeAssignmentConflictProblem(traceId: string, detail: string): ProblemResponse {
  return problemResponse(
    409,
    'https://boxalarm.dev/problems/ppe-assignment-conflict',
    'PPE Assignment Conflict',
    detail,
    traceId,
  );
}
