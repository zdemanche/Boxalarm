import type {
  APIGatewayProxyEventHeaders,
  APIGatewayProxyEventV2WithLambdaAuthorizer,
} from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../platform-service/authorizer/handler.js';

export type IncidentEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;

export interface IncidentAuthContext {
  readonly deptId: VerifiedDeptId;
  readonly sub: string;
  readonly isAdmin: boolean;
}

const ADMIN_GROUPS = new Set(['ADMIN', 'CHIEF']);

// TODO(E8-S3): replace with a Verified Permissions IsAuthorizedWithToken Cedar check once the
// admin/officer role policy exists; this parses the authorizer's already-verified
// cognito:groups claim as an interim, fail-secure stand-in, not a permanent substitute.
function isAdminFromGroups(groups: string): boolean {
  return groups.split(' ').some((group) => ADMIN_GROUPS.has(group));
}

export function readAuthorizerContext(event: IncidentEvent): IncidentAuthContext {
  const lambdaContext = event.requestContext.authorizer?.lambda as
    Partial<AuthorizerContext> | undefined;
  const rawDeptId = lambdaContext?.deptId;
  if (typeof rawDeptId !== 'string' || rawDeptId.trim().length === 0) {
    throw new Error('authorizer context deptId is required and was not present on the event');
  }
  const rawSub = lambdaContext?.sub;
  if (typeof rawSub !== 'string' || rawSub.trim().length === 0) {
    throw new Error('authorizer context sub is required and was not present on the event');
  }
  const rawGroups = lambdaContext?.['cognito:groups'];
  return {
    deptId: toVerifiedDeptId({ deptId: rawDeptId }),
    sub: rawSub,
    isAdmin: isAdminFromGroups(typeof rawGroups === 'string' ? rawGroups : ''),
  };
}

export interface ProblemResponse {
  readonly statusCode: number;
  readonly headers: { readonly 'Content-Type': string };
  readonly body: string;
}

// Mirrors personnel-service/lib/problemDetails.ts's resolveTraceId: the caller's W3C
// traceparent header takes precedence so a reported failure can be joined to the caller's
// trace; the request id is the fallback when no traceparent was sent.
export function resolveTraceId(headers: APIGatewayProxyEventHeaders, fallback: string): string {
  const traceparent = headers.traceparent ?? headers.Traceparent;
  if (traceparent) {
    const parts = traceparent.split('-');
    if (parts.length === 4 && parts[1]) {
      return parts[1];
    }
  }
  return fallback;
}

export function problemResponse(
  status: number,
  title: string,
  detail: string,
  traceId: string,
): ProblemResponse {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/problem+json' },
    body: JSON.stringify({ type: 'about:blank', title, status, detail, traceId }),
  };
}

export function emitIncidentMetric(name: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/incident-service',
            Dimensions: [[]],
            Metrics: [{ Name: name, Unit: 'Count' }],
          },
        ],
      },
      [name]: 1,
    }),
  );
}

export function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
