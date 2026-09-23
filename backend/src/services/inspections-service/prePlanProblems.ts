export interface ProblemDetailsBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly traceId: string;
}

export interface ProblemResponse {
  readonly statusCode: number;
  readonly headers: { readonly 'content-type': 'application/problem+json' };
  readonly body: string;
}

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

export function notFoundProblem(detail: string, traceId: string): ProblemResponse {
  return problemResponse(
    404,
    'https://boxalarm.dev/problems/not-found',
    'Not Found',
    detail,
    traceId,
  );
}

export function invalidRequestProblem(detail: string, traceId: string): ProblemResponse {
  return problemResponse(
    400,
    'https://boxalarm.dev/problems/invalid-request',
    'Invalid Request',
    detail,
    traceId,
  );
}

export function conflictProblem(detail: string, traceId: string): ProblemResponse {
  return problemResponse(
    409,
    'https://boxalarm.dev/problems/conflict',
    'Conflict',
    detail,
    traceId,
  );
}

export function dependencyUnavailableProblem(traceId: string): ProblemResponse {
  return problemResponse(
    503,
    'https://boxalarm.dev/problems/dependency-unavailable',
    'Dependency Unavailable',
    'A required upstream dependency is temporarily unavailable.',
    traceId,
  );
}
