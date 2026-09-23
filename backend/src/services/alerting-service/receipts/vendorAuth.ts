import { createHash, timingSafeEqual } from 'node:crypto';
import { extractTraceId as extractTraceIdFromAuthz, type GuardEvent } from '@boxalarm/authz';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

// ponytail: static shared-secret verification for all three channels; SMS/voice vendor is
// unconfirmed (architecture §5 OQ-3) so vendor-native signature verification (e.g. Twilio's
// X-Twilio-Signature HMAC) can't be implemented against a real contract yet — upgrade once a
// vendor is selected.
export function verifyVendorSecret(provided: string | undefined, expected: string): boolean {
  if (!provided) {
    return false;
  }
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export function extractTraceId(event: APIGatewayProxyEventV2): string {
  return extractTraceIdFromAuthz(event as unknown as GuardEvent);
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
