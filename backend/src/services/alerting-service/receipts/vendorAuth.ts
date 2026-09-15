import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

export function verifyVendorSecret(provided: string | undefined, expected: string): boolean {
  if (!provided) {
    return false;
  }
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export function extractTraceId(event: APIGatewayProxyEventV2): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

export function unauthorizedVendorProblem(
  traceId: string,
  detail: string,
): APIGatewayProxyResultV2 {
  return {
    statusCode: 401,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: 'https://boxalarm.dev/problems/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail,
      traceId,
    }),
  };
}
