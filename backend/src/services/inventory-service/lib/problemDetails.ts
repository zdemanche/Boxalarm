import type { AuthorizerContext } from '../../platform-service/authorizer/handler.js';

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

export class ForbiddenError extends ProblemError {
  constructor(detail: string) {
    super(403, 'Forbidden', detail);
  }
}

export class NotFoundError extends ProblemError {
  constructor(detail: string) {
    super(404, 'Not Found', detail);
  }
}

export class DependencyUnavailableError extends ProblemError {
  constructor(detail: string) {
    super(500, 'Dependency Unavailable', detail);
  }
}

const ADMIN_GROUPS = new Set(['ADMIN', 'CHIEF', 'OFFICER']);

// TODO: E8-S3 — replace this cognito:groups check with Cedar IsAuthorizedWithToken
export function requireAdminGroup(context: AuthorizerContext): void {
  const groups = context['cognito:groups'].split(' ').filter((group) => group.length > 0);
  if (!groups.some((group) => ADMIN_GROUPS.has(group))) {
    throw new ForbiddenError('caller lacks an admin-equivalent role (ADMIN, CHIEF, or OFFICER)');
  }
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
