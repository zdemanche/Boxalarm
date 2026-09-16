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

export function unauthorizedProblem(traceId: string): ProblemResponse {
  return problemResponse(
    401,
    'https://boxalarm.dev/problems/unauthorized',
    'Unauthorized',
    'The request is missing a valid bearer token or authenticated principal.',
    traceId,
  );
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
