import type { GuardEvent } from '@boxalarm/authz';
import { assertNoDelimiter } from '@boxalarm/dept-scope';
import { problemResponse, type ProblemResponse } from './authContext.js';

/** The `{incidentId}` path parameter, or the 400 to return. */
export function readIncidentIdParam(event: GuardEvent, traceId: string): string | ProblemResponse {
  const incidentId = event.pathParameters?.incidentId;
  if (!incidentId) {
    return problemResponse(400, 'Bad Request', 'incidentId path parameter is required.', traceId);
  }
  try {
    assertNoDelimiter(incidentId, 'incidentId');
  } catch (error) {
    return problemResponse(
      400,
      'Bad Request',
      error instanceof Error ? error.message : 'incidentId path parameter is invalid.',
      traceId,
    );
  }
  return incidentId;
}

export type BodyResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly problem: ProblemResponse };

/** The JSON-object body (an empty object when optional and absent), or the 400 to return. */
export function readJsonObject(
  event: GuardEvent,
  traceId: string,
  options: { readonly optional?: boolean } = {},
): BodyResult {
  const fail = (detail: string): BodyResult => ({
    ok: false,
    problem: problemResponse(400, 'Bad Request', detail, traceId),
  });
  if (!event.body) {
    return options.optional ? { ok: true, body: {} } : fail('request body is required');
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('request body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('request body must be a JSON object');
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}
