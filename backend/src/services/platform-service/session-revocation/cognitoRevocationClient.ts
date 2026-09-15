import {
  AdminGetUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { captureAWSv3Client } from 'aws-xray-sdk-core';

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
            Namespace: 'Boxalarm/SessionRevocation',
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
