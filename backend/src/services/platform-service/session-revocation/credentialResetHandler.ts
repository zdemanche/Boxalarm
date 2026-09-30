import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { UserNotFoundException } from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  extractTraceId,
  forbiddenProblem,
  notFoundProblem,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import {
  createRevocationClient,
  readRevocationConfig,
  resetMemberPassword,
  resolveMemberDeptId,
  revokeMemberSession,
} from './cognitoRevocationClient.js';
import { getAccessStoreClient, readPlatformTableName } from './memberAccessStore.js';
import { writeRevocationMarker } from '../authorizer/revocationStore.js';

let cachedClient: CognitoIdentityProviderClient | undefined;

function getClient(): CognitoIdentityProviderClient {
  cachedClient ??= createRevocationClient();
  return cachedClient;
}

export function readTargetMemberId(body: string | undefined | null): string | undefined {
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

function log(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event, service: 'platform-service', ...fields }));
}

/**
 * POST /api/v1/platform/sessions/reset-credentials - the compromised-password kill switch
 * (OQ-24, review C1). A global sign-out alone does nothing here: the attacker holds the
 * password and signs straight back in. This first puts the login into RESET_REQUIRED, so the
 * current password stops working, then signs out every session so no refresh token minted
 * before (or during) the reset survives. The member recovers through the self-service
 * forgot-password flow (F9.1) - no human step, no MFA, no step-up (CLAUDE.md, settled).
 *
 * CHIEF/ADMIN via the Cedar ResetMemberCredentials action, and alarmed on every invocation
 * like export: with no second factor behind the admin account, detection is the control.
 */
async function resetCredentials(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = readTargetMemberId(event.body);
  if (!memberId) {
    return badRequestProblem(traceId, 'memberId is required and must be a non-empty string.');
  }

  // A missing env var is a deploy fault; answer it as problem+json with the traceId like
  // every other failure here (review minor 13), not an unshaped 500.
  let userPoolId: string;
  let tableName: string;
  try {
    ({ userPoolId } = readRevocationConfig(process.env));
    tableName = readPlatformTableName(process.env);
  } catch (error) {
    log('credentialReset.configError', {
      traceId,
      message: error instanceof Error ? error.message : undefined,
    });
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/problem+json' },
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'Credential reset is misconfigured.',
        traceId,
      }),
    };
  }
  const client = getClient();

  let targetDeptId: string | undefined;
  try {
    targetDeptId = await resolveMemberDeptId(client, { userPoolId, username: memberId });
  } catch (error) {
    if (error instanceof UserNotFoundException) {
      return notFoundProblem(traceId, `No member found for memberId "${memberId}".`);
    }
    log('credentialReset.deptLookupFailed', {
      memberId,
      traceId,
      message: error instanceof Error ? error.message : undefined,
    });
    return serviceUnavailableProblem(traceId);
  }
  // Fail closed, as deviceLossHandler: only a member verified to be in the caller's own
  // department (F9.6), including when the target's department cannot be resolved.
  if (targetDeptId !== principal.deptId) {
    log('credentialReset.denied', { reason: 'CrossDepartmentTarget', memberId, traceId });
    return forbiddenProblem(traceId);
  }

  // M1: refuse the access tokens already issued - they are verified offline and would
  // otherwise keep working for up to an hour after the reset. Written before the reset AND
  // again after the sign-out (review minor 4), so a refresh that squeezed in between cannot
  // leave a token with iat > revokedAt alive.
  const writeMarker = async (): Promise<boolean> => {
    try {
      await writeRevocationMarker(getAccessStoreClient(), tableName, {
        deptId: principal.deptId,
        sub: memberId,
        reason: 'CREDENTIAL_RESET',
        actorId: principal.sub,
      });
      return true;
    } catch (error) {
      log('credentialReset.markerFailed', {
        memberId,
        traceId,
        message: error instanceof Error ? error.message : undefined,
      });
      return false;
    }
  };
  if (!(await writeMarker())) {
    return serviceUnavailableProblem(traceId);
  }

  const input = { userPoolId, username: memberId, correlationId: traceId };
  // Reset before sign-out: a sign-out first would leave a window where the old password
  // mints a fresh refresh token that nothing then revokes.
  let resetError: unknown;
  try {
    await resetMemberPassword(client, input);
  } catch (error) {
    resetError = error;
  }
  // Signed out whatever the reset did: ending the sessions that exist is never wrong here.
  try {
    await revokeMemberSession(client, input);
  } catch (error) {
    if (error instanceof UserNotFoundException) {
      return notFoundProblem(traceId, `No member found for memberId "${memberId}".`);
    }
    return serviceUnavailableProblem(traceId);
  }

  if (!(await writeMarker())) {
    return serviceUnavailableProblem(traceId);
  }

  if (resetError) {
    // Typically InvalidParameterException: no verified email or phone to send a code to.
    const reason = resetError instanceof Error ? resetError.constructor.name : 'UnknownError';
    return {
      statusCode: 409,
      headers: { 'content-type': 'application/problem+json' },
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail:
          `Every session was signed out, but the password could not be reset (${reason}). ` +
          "Correct the member's email on their page (Account security > Change email - it " +
          'updates where reset codes go), then reset again. Until then, set them to Leave of ' +
          'absence (Status > Change status) to block sign-in.',
        traceId,
      }),
    };
  }

  console.log(
    JSON.stringify({
      event: 'credentialReset.completed',
      service: 'platform-service',
      memberId,
      actorId: principal.sub,
      traceId,
    }),
  );
  return {
    statusCode: 202,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memberId, status: 'password-reset-and-signed-out' }),
  };
}

export const handler = withAuthorization(resetCredentials, {
  actionType: 'Boxalarm::Action',
  actionId: 'ResetMemberCredentials',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => readTargetMemberId(event.body) ?? '',
  alarmOnInvocation: 'ResetMemberCredentialsInvoked',
});
