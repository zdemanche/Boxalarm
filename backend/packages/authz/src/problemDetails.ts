export interface FieldError {
  readonly field: string;
  readonly detail: string;
}

export interface ProblemDetailsBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly traceId: string;
  readonly errors?: readonly FieldError[];
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
  errors?: readonly FieldError[],
): ProblemResponse {
  const body: ProblemDetailsBody = {
    type,
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

export function forbiddenProblem(traceId: string): ProblemResponse {
  return problemResponse(
    403,
    'https://boxalarm.dev/problems/forbidden',
    'Forbidden',
    'The authenticated principal is not authorized to perform this action.',
    traceId,
  );
}

export function serviceUnavailableProblem(traceId: string): ProblemResponse {
  return problemResponse(
    503,
    'https://boxalarm.dev/problems/service-unavailable',
    'Service Unavailable',
    'The authorization service is temporarily unavailable.',
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

export function notFoundProblem(traceId: string, detail: string): ProblemResponse {
  return problemResponse(
    404,
    'https://boxalarm.dev/problems/not-found',
    'Not Found',
    detail,
    traceId,
  );
}

export function badRequestProblem(
  traceId: string,
  detailOrErrors: string | readonly FieldError[],
): ProblemResponse {
  if (typeof detailOrErrors === 'string') {
    return problemResponse(
      400,
      'https://boxalarm.dev/problems/bad-request',
      'Bad Request',
      detailOrErrors,
      traceId,
    );
  }
  return problemResponse(
    400,
    'https://boxalarm.dev/problems/bad-request',
    'Bad Request',
    'The request failed validation.',
    traceId,
    detailOrErrors,
  );
}
