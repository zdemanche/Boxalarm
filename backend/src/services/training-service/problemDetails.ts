export interface TrainingProblemDetailsBody {
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
  const body: TrainingProblemDetailsBody = { type, title, status, detail, traceId };
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify(body),
  };
}

export const badRequestProblem = (traceId: string, detail: string): ProblemResponse =>
  problemResponse(400, 'https://boxalarm.dev/problems/bad-request', 'Bad Request', detail, traceId);

export const eventNotFoundProblem = (traceId: string): ProblemResponse =>
  problemResponse(
    404,
    'https://boxalarm.dev/problems/training-event-not-found',
    'Training Event Not Found',
    'The requested training event does not exist.',
    traceId,
  );

export const signupAfterEventStartedProblem = (traceId: string): ProblemResponse =>
  problemResponse(
    422,
    'https://boxalarm.dev/problems/signup-after-event-started',
    'Signup Window Closed',
    'Sign-up is only available before the training event starts.',
    traceId,
  );

export const duplicateSignupProblem = (traceId: string): ProblemResponse =>
  problemResponse(
    409,
    'https://boxalarm.dev/problems/duplicate-signup',
    'Already Signed Up',
    'This member is already signed up for this training event.',
    traceId,
  );
