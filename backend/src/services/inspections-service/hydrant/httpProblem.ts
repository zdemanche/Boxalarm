export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly traceId: string;
}

export interface ProblemResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export function problemResponse(
  status: number,
  title: string,
  detail: string,
  traceId: string,
): ProblemResponse {
  const problem: ProblemDetails = {
    type: `https://boxalarm.dev/problems/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    title,
    status,
    detail,
    traceId,
  };
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify(problem),
  };
}
