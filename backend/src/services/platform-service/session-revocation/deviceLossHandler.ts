import { randomUUID } from 'node:crypto';
import { UserNotFoundException } from '@aws-sdk/client-cognito-identity-provider';
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type {
  APIGatewayProxyEventHeaders,
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
  Handler,
} from 'aws-lambda';
import type { AuthorizerContext } from '../authorizer/handler.js';
import {
  createRevocationClient,
  readRevocationConfig,
  resolveMemberDeptId,
  revokeMemberSession,
} from './cognitoRevocationClient.js';
import type { RevocationConfig } from './cognitoRevocationClient.js';

// TODO: E8-S3 — replace with Cedar IsAuthorizedWithToken once Verified Permissions ships.
const ADMIN_GROUPS = new Set(['CHIEF', 'ADMIN']);

let cachedClient: CognitoIdentityProviderClient | undefined;

function getClient(): CognitoIdentityProviderClient {
  cachedClient ??= createRevocationClient();
  return cachedClient;
}

function extractTraceId(headers: APIGatewayProxyEventHeaders): string {
  const traceparent = headers.traceparent ?? headers.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function problemDetails(
  statusCode: number,
  title: string,
  detail: string,
  traceId: string,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({ type: 'about:blank', title, status: statusCode, detail, traceId }),
  };
}

function isCallerAdmin(context: AuthorizerContext): boolean {
  const groups = context['cognito:groups'].split(' ').filter((group) => group.length > 0);
  return groups.some((group) => ADMIN_GROUPS.has(group));
}

function readMemberId(body: string | undefined): string | undefined {
  if (!body) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const memberId = (parsed as { memberId?: unknown } | null)?.memberId;
  return typeof memberId === 'string' && memberId.trim().length > 0 ? memberId : undefined;
}

export const handler: Handler<
  APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>,
  APIGatewayProxyStructuredResultV2
> = async (event) => {
  const traceId = extractTraceId(event.headers);
  const authorizerContext = event.requestContext.authorizer.lambda;

  if (!isCallerAdmin(authorizerContext)) {
    console.error(
      JSON.stringify({ event: 'deviceLossRevocation.denied', reason: 'InsufficientRole', traceId }),
    );
    return problemDetails(403, 'Forbidden', 'CHIEF or ADMIN role is required.', traceId);
  }

  const memberId = readMemberId(event.body);
  if (!memberId) {
    return problemDetails(
      400,
      'Bad Request',
      'memberId is required and must be a non-empty string.',
      traceId,
    );
  }

  let config: RevocationConfig;
  try {
    config = readRevocationConfig(process.env);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'deviceLossRevocation.configError',
        message: error instanceof Error ? error.message : undefined,
        traceId,
      }),
    );
    return problemDetails(
      500,
      'Internal Server Error',
      'Session revocation is misconfigured.',
      traceId,
    );
  }
  const { userPoolId } = config;
  const client = getClient();

  let targetDeptId: string | undefined;
  try {
    targetDeptId = await resolveMemberDeptId(client, { userPoolId, username: memberId });
  } catch (error) {
    if (error instanceof UserNotFoundException) {
      return problemDetails(
        404,
        'Not Found',
        `No member found for memberId "${memberId}".`,
        traceId,
      );
    }
    console.error(
      JSON.stringify({
        event: 'deviceLossRevocation.deptLookupFailed',
        message: error instanceof Error ? error.message : undefined,
        memberId,
        traceId,
      }),
    );
    return problemDetails(
      503,
      'Service Unavailable',
      'Session revocation is temporarily unavailable.',
      traceId,
    );
  }

  // Fail closed: a caller may only revoke a member verified as belonging to their own
  // department (F9.6) — including when the target's department cannot be resolved at all.
  if (targetDeptId !== authorizerContext.deptId) {
    console.error(
      JSON.stringify({
        event: 'deviceLossRevocation.denied',
        reason: 'CrossDepartmentTarget',
        memberId,
        traceId,
      }),
    );
    return problemDetails(403, 'Forbidden', 'memberId is not in the caller’s department.', traceId);
  }

  try {
    await revokeMemberSession(client, { userPoolId, username: memberId, correlationId: traceId });
  } catch (error) {
    // revokeMemberSession already logged the original error and emitted the failure metric.
    if (error instanceof UserNotFoundException) {
      return problemDetails(
        404,
        'Not Found',
        `No member found for memberId "${memberId}".`,
        traceId,
      );
    }
    return problemDetails(
      503,
      'Service Unavailable',
      'Session revocation is temporarily unavailable.',
      traceId,
    );
  }

  return { statusCode: 202, body: JSON.stringify({ memberId, status: 'revoked' }) };
};
