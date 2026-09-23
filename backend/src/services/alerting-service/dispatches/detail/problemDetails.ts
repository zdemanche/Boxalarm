import type { ProblemResponse } from '@boxalarm/authz';

export function dataUnavailableProblem(traceId: string): ProblemResponse {
  return {
    statusCode: 503,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: 'https://boxalarm.dev/problems/service-unavailable',
      title: 'Service Unavailable',
      status: 503,
      detail: 'The alert data store is temporarily unavailable.',
      traceId,
    }),
  };
}
