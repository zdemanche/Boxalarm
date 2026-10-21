export class ProblemError extends Error {
  readonly status: number;
  readonly title: string;
  readonly type: string;

  constructor(status: number, title: string, detail: string, type = 'about:blank') {
    super(detail);
    this.status = status;
    this.title = title;
    this.type = type;
  }
}

export class ValidationError extends ProblemError {
  constructor(detail: string) {
    super(400, 'Validation Failed', detail);
  }
}

export class NotFoundError extends ProblemError {
  constructor(detail: string) {
    super(404, 'Not Found', detail);
  }
}

export class ConflictError extends ProblemError {
  constructor(detail: string) {
    super(409, 'Conflict', detail);
  }
}

export class DependencyUnavailableError extends ProblemError {
  constructor(detail: string) {
    super(500, 'Dependency Unavailable', detail);
  }
}

export function parseJsonBody(body: string | null | undefined): Record<string, unknown> {
  if (!body) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ValidationError('request body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError('request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function requirePathId(value: string | undefined, name: string): string {
  if (!value) {
    throw new ValidationError(`${name} path parameter is required`);
  }
  if (value.includes('#')) {
    throw new ValidationError(`${name} path parameter must not contain "#"`);
  }
  return value;
}

export interface ProblemResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export function toProblemResponse(
  error: unknown,
  instance: string,
  traceId: string,
): ProblemResponse {
  const problem =
    error instanceof ProblemError
      ? error
      : new ProblemError(500, 'Internal Server Error', 'An unexpected error occurred');
  return {
    statusCode: problem.status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: problem.type,
      title: problem.title,
      status: problem.status,
      detail: problem.message,
      instance,
      traceId,
    }),
  };
}
