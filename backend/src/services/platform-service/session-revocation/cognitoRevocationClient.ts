import {
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminResetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { captureAWSv3Client } from 'aws-xray-sdk-core';

/**
 * Username for every admin call below is the member's id, which is the Cognito `sub`.
 * Logins are created with Username = email (personnel-service memberLogin.ts) and this pool
 * sets neither usernameAttributes nor aliasAttributes, so the email is the username and is
 * not an alias. Cognito's admin APIs document that when the value passed is not an alias it
 * "must be the sub of a local user", so the sub resolves to the same user - no email lookup
 * (and no ListUsers call) is needed. A value that resolves to no user surfaces as
 * UserNotFoundException, which every caller treats as "already gone", never as success.
 */
export interface RevocationConfig {
  readonly userPoolId: string;
}

export function readRevocationConfig(env: NodeJS.ProcessEnv): RevocationConfig {
  const userPoolId = env.COGNITO_USER_POOL_ID;
  if (!userPoolId) {
    throw new Error('COGNITO_USER_POOL_ID is required and was not set');
  }
  return { userPoolId };
}

export function createRevocationClient(
  sdkClientOverride?: CognitoIdentityProviderClient,
): CognitoIdentityProviderClient {
  return sdkClientOverride ?? captureAWSv3Client(new CognitoIdentityProviderClient({}));
}

function emitRevocationMetric(outcome: 'Succeeded' | 'Failed' | 'Skipped', reason?: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/session-revocation',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: `Revocation${outcome}`, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [`Revocation${outcome}`]: 1,
    }),
  );
}

export interface RevokeSessionInput {
  readonly userPoolId: string;
  readonly username: string;
  readonly correlationId?: string | undefined;
}

export async function revokeMemberSession(
  client: CognitoIdentityProviderClient,
  input: RevokeSessionInput,
): Promise<void> {
  try {
    await client.send(
      new AdminUserGlobalSignOutCommand({
        UserPoolId: input.userPoolId,
        Username: input.username,
      }),
    );
    emitRevocationMetric('Succeeded');
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    // UserNotFoundException means the member is already gone from Cognito -- an expected,
    // non-alertable outcome, not an operational failure -- so it gets its own event/metric
    // name rather than sharing sessionRevocation.failed / RevocationFailed with genuine
    // outages (throttling, permission errors).
    const isKnownGone = error instanceof UserNotFoundException;
    console.error(
      JSON.stringify({
        event: isKnownGone ? 'sessionRevocation.skipped' : 'sessionRevocation.failed',
        reason,
        message: error instanceof Error ? error.message : undefined,
        username: input.username,
        userPoolId: input.userPoolId,
        correlationId: input.correlationId,
        service: 'platform-service',
      }),
    );
    emitRevocationMetric(isKnownGone ? 'Skipped' : 'Failed', reason);
    throw error;
  }
}

export interface ResolveMemberDeptIdInput {
  readonly userPoolId: string;
  readonly username: string;
}

export async function resolveMemberDeptId(
  client: CognitoIdentityProviderClient,
  input: ResolveMemberDeptIdInput,
): Promise<string | undefined> {
  const result = await client.send(
    new AdminGetUserCommand({ UserPoolId: input.userPoolId, Username: input.username }),
  );
  return result.UserAttributes?.find((attribute) => attribute.Name === 'custom:deptId')?.Value;
}

/**
 * Security-web MINOR 6: the kill switches (reset credentials, report device lost) ended any
 * member's access, including another chief's or admin's - so one compromised chief password
 * could sign out and lock out every other chief and admin. A CHIEF or ADMIN target now needs an
 * ADMIN caller, the same shape as personnel's protected-target rule for status changes.
 */
const PROTECTED_TARGET_GROUPS: ReadonlySet<string> = new Set(['CHIEF', 'ADMIN']);

/** Whether the member's login is in a CHIEF or ADMIN group (Cognito groups are what Cedar reads). */
export async function isProtectedTarget(
  client: CognitoIdentityProviderClient,
  input: ResolveMemberDeptIdInput,
): Promise<boolean> {
  let nextToken: string | undefined;
  do {
    const page = await client.send(
      new AdminListGroupsForUserCommand({
        UserPoolId: input.userPoolId,
        Username: input.username,
        NextToken: nextToken,
      }),
    );
    if ((page.Groups ?? []).some((group) => PROTECTED_TARGET_GROUPS.has(group.GroupName ?? ''))) {
      return true;
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return false;
}

/** Whether the caller may act on a protected (CHIEF/ADMIN) target: an ADMIN only. */
export function mayActOnProtectedTarget(callerGroups: string): boolean {
  return callerGroups.split(' ').includes('ADMIN');
}

export type LoginStateOperation = 'Disable' | 'Enable' | 'ResetPassword';

function emitLoginStateMetric(
  operation: LoginStateOperation,
  outcome: 'Succeeded' | 'Failed',
  reason?: string,
): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/session-revocation',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: `Login${operation}${outcome}`, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [`Login${operation}${outcome}`]: 1,
    }),
  );
}

async function sendLoginStateCommand(
  client: CognitoIdentityProviderClient,
  operation: LoginStateOperation,
  input: RevokeSessionInput,
): Promise<void> {
  const params = { UserPoolId: input.userPoolId, Username: input.username };
  try {
    if (operation === 'Disable') {
      await client.send(new AdminDisableUserCommand(params));
    } else if (operation === 'Enable') {
      await client.send(new AdminEnableUserCommand(params));
    } else {
      await client.send(new AdminResetUserPasswordCommand(params));
    }
    emitLoginStateMetric(operation, 'Succeeded');
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    console.error(
      JSON.stringify({
        event: `memberLogin.${operation.charAt(0).toLowerCase()}${operation.slice(1)}.failed`,
        reason,
        message: error instanceof Error ? error.message : undefined,
        username: input.username,
        userPoolId: input.userPoolId,
        correlationId: input.correlationId,
        service: 'platform-service',
      }),
    );
    emitLoginStateMetric(operation, 'Failed', reason);
    throw error;
  }
}

/**
 * Stops the member signing in or refreshing a token (C1). A global sign-out alone ends the
 * refresh tokens that exist, but the same password signs straight back in; a disabled user
 * cannot authenticate or redeem a refresh token at all. Chosen over removing the role
 * groups: a group-less login still gets a department-scoped token that every "Cognito" tier
 * route (roster, member PII, incidents) accepts, and stripping groups would lose the roles
 * a returning member must get back. Reversible with enableMemberLogin, idempotent.
 */
export async function disableMemberLogin(
  client: CognitoIdentityProviderClient,
  input: RevokeSessionInput,
): Promise<void> {
  await sendLoginStateCommand(client, 'Disable', input);
}

/** Undoes disableMemberLogin when the member returns to ACTIVE. Idempotent. */
export async function enableMemberLogin(
  client: CognitoIdentityProviderClient,
  input: RevokeSessionInput,
): Promise<void> {
  await sendLoginStateCommand(client, 'Enable', input);
}

/**
 * The compromised-password case: the current password stops working and the member sets a
 * new one through the self-service forgot-password flow (F9.1 - no human step). Cognito
 * sends the reset code to the verified email every login is created with.
 */
export async function resetMemberPassword(
  client: CognitoIdentityProviderClient,
  input: RevokeSessionInput,
): Promise<void> {
  await sendLoginStateCommand(client, 'ResetPassword', input);
}
