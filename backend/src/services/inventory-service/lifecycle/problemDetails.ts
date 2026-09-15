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

export function assetNotFoundProblem(traceId: string, assetId: string): ProblemResponse {
  return problemResponse(
    404,
    'https://boxalarm.dev/problems/asset-not-found',
    'Asset Not Found',
    `No equipment asset was found for assetId "${assetId}".`,
    traceId,
  );
}

export function invalidLifecycleTransitionProblem(
  traceId: string,
  detail: string,
): ProblemResponse {
  return problemResponse(
    409,
    'https://boxalarm.dev/problems/invalid-lifecycle-transition',
    'Invalid Lifecycle Transition',
    detail,
    traceId,
  );
}

export function invalidLifecycleRequestProblem(traceId: string, detail: string): ProblemResponse {
  return problemResponse(
    400,
    'https://boxalarm.dev/problems/invalid-lifecycle-request',
    'Invalid Lifecycle Request',
    detail,
    traceId,
  );
}
