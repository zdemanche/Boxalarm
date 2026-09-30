import { randomUUID } from 'node:crypto';
import { UserNotFoundException } from '@aws-sdk/client-cognito-identity-provider';
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventHeaders, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { withAuthorization, type CedarPrincipalContext, type GuardEvent } from '@boxalarm/authz';
import {
  createRevocationClient,
  readRevocationConfig,
  resolveMemberDeptId,
  revokeMemberSession,
} from './cognitoRevocationClient.js';
import type { RevocationConfig } from './cognitoRevocationClient.js';
import {
  getAccessStoreClient,
  invalidateMemberPush,
  readPlatformTableName,
} from './memberAccessStore.js';
import { writeRevocationMarker } from '../authorizer/revocationStore.js';
import { parseDeviceId } from '../../personnel-service/pushTokens/pushDevices.js';

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

function parseBody(body: string | undefined | null): unknown {
  if (!body) {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function readMemberId(body: string | undefined | null): string | undefined {
  const memberId = (parseBody(body) as { memberId?: unknown } | null | undefined)?.memberId;
  return typeof memberId === 'string' && memberId.trim().length > 0 ? memberId : undefined;
}

/**
 * The lost device, when the admin identified it (GET .../devices lists them): only that
 * installation's push registration is removed. Absent means every push device - the admin
 * does not know which one, so none of them may keep showing dispatches.
 */
function readDeviceId(body: string | undefined | null): string | undefined {
  return parseDeviceId((parseBody(body) as { deviceId?: unknown } | null | undefined)?.deviceId);
}

async function revokeLostDevice(
  event: GuardEvent,
  authorizerContext: CedarPrincipalContext,
): Promise<APIGatewayProxyStructuredResultV2> {
  const traceId = extractTraceId(event.headers ?? {});

  const memberId = readMemberId(event.body);
  if (!memberId) {
    return problemDetails(
      400,
      'Bad Request',
      'memberId is required and must be a non-empty string.',
      traceId,
    );
  }
  let deviceId: string | undefined;
  try {
    deviceId = readDeviceId(event.body);
  } catch (error) {
    return problemDetails(
      400,
      'Bad Request',
      error instanceof Error ? error.message : 'deviceId is invalid.',
      traceId,
    );
  }

  let config: RevocationConfig;
  let tableName: string;
  try {
    config = readRevocationConfig(process.env);
    tableName = readPlatformTableName(process.env);
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

  // M1: refuse the access token the lost device already holds - it is verified offline and
  // would otherwise keep working for up to an hour. The member-wide marker costs the other
  // devices nothing extra: the global sign-out below already ends every refresh token.
  // Written before the sign-out AND again after it (review minor 4): a refresh that lands
  // between the first write and the sign-out, a second later, mints a token with
  // iat > revokedAt that would otherwise live for an hour; device loss has no disable or
  // pre-token status check to catch it.
  const writeMarker = async (): Promise<boolean> => {
    try {
      await writeRevocationMarker(getAccessStoreClient(), tableName, {
        deptId: authorizerContext.deptId,
        sub: memberId,
        reason: 'DEVICE_LOSS',
        actorId: authorizerContext.sub,
      });
      return true;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'deviceLossRevocation.markerFailed',
          message: error instanceof Error ? error.message : undefined,
          memberId,
          traceId,
        }),
      );
      return false;
    }
  };
  const unavailable = () =>
    problemDetails(
      503,
      'Service Unavailable',
      'Session revocation is temporarily unavailable.',
      traceId,
    );
  if (!(await writeMarker())) {
    return unavailable();
  }

  // M2 - per-device revocation is not available, so this is a member-wide sign-out. The
  // architecture promises "per-device revocation"; what exists today cannot deliver it:
  //  - Cognito device tracking does not apply to the hosted-UI authorization-code flow both
  //    apps use, so there is no device key to forget (AdminForgetDevice).
  //  - RevokeToken revokes one refresh token but needs the token itself; nothing stores
  //    which refresh token (or origin_jti) belongs to which phone.
  // Cost: the member's other devices lose their refresh tokens too and need one interactive
  // sign-in - an admin must tell the member. Path to real per-device revocation: record the
  // access token's origin_jti (stable across a device's refreshes) against the device at
  // push-token registration, and have the authorizer deny that origin_jti instead of the
  // whole member.
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

  // Sessions are already revoked; the whole call is idempotent, so a retry finishes it.
  if (!(await writeMarker())) {
    return unavailable();
  }

  // M2: the lost phone must stop showing dispatches on its lock screen - only that device
  // when the admin identified it, otherwise every push device the member has.
  let push: Awaited<ReturnType<typeof invalidateMemberPush>>;
  try {
    push = await invalidateMemberPush(
      getAccessStoreClient(),
      tableName,
      authorizerContext.deptId,
      memberId,
      traceId,
      authorizerContext.sub,
      deviceId,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'deviceLossRevocation.pushInvalidationFailed',
        message: error instanceof Error ? error.message : undefined,
        memberId,
        traceId,
      }),
    );
    // Sessions are already revoked; the whole call is idempotent, so a retry finishes it.
    return problemDetails(
      503,
      'Service Unavailable',
      'Sessions were revoked but the device push registration could not be removed; retry.',
      traceId,
    );
  }

  return {
    statusCode: 202,
    body: JSON.stringify({
      memberId,
      status: 'revoked',
      push,
      ...(deviceId !== undefined ? { deviceId } : {}),
    }),
  };
}

/**
 * POST /api/v1/platform/sessions/revoke - report a device lost. Body `{ memberId, deviceId? }`:
 * every session is signed out either way (see M2 above); push is removed from `deviceId` only,
 * or from every device when it is absent. Gated by the Cedar
 * RevokeSession action (CHIEF/ADMIN, ADMIN_ONLY_ACTIONS) instead of the hand-written group
 * check it used to carry (original review minor 10), and alarmed on every invocation like
 * the other kill switch (ResetMemberCredentials).
 */
export const handler = withAuthorization(revokeLostDevice, {
  actionType: 'Boxalarm::Action',
  actionId: 'RevokeSession',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => readMemberId(event.body) ?? '',
  alarmOnInvocation: 'RevokeSessionInvoked',
});
