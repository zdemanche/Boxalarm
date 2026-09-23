import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../platform-service/authorizer/handler.js';

export type ApparatusEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;

export interface ApparatusAuthContext {
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

export function readAuthorizerContext(event: ApparatusEvent): ApparatusAuthContext {
  const lambdaContext = event.requestContext.authorizer?.lambda as
    Partial<AuthorizerContext> | undefined;
  const rawDeptId = lambdaContext?.deptId;
  if (typeof rawDeptId !== 'string' || rawDeptId.trim().length === 0) {
    throw new Error('authorizer context deptId is required and was not present on the event');
  }
  const rawSub = lambdaContext?.sub;
  const rawGroups = lambdaContext?.['cognito:groups'];
  return {
    deptId: toVerifiedDeptId({ deptId: rawDeptId }),
    sub: typeof rawSub === 'string' ? rawSub : '',
    isAdmin: isAdminFromGroups(typeof rawGroups === 'string' ? rawGroups : ''),
  };
}

export interface ProblemResponse {
  readonly statusCode: number;
  readonly headers: { readonly 'Content-Type': string };
  readonly body: string;
}

export function getTraceId(env: NodeJS.ProcessEnv): string {
  const rootMatch = env._X_AMZN_TRACE_ID?.match(/Root=([^;]+)/);
  return rootMatch?.[1] ?? randomUUID();
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

export function emitApparatusMetric(name: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/apparatus-service',
            Dimensions: [[]],
            Metrics: [{ Name: name, Unit: 'Count' }],
          },
        ],
      },
      [name]: 1,
    }),
  );
}
