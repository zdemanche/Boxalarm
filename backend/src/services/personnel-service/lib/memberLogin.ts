import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  InvalidParameterException,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { MEMBER_ROLES, type MemberRole } from './memberRepository.js';

/**
 * Every member is a Cognito user, and the member's id IS that user's `sub`. The apps send
 * the ID-token `sub` as their memberId, the authorizer and every own-record check compare
 * against the access-token `sub`, and session revocation looks members up in Cognito by
 * memberId - so a member row keyed on anything else can never be reached by its own
 * member. The login also carries `custom:deptId`, without which the authorizer denies
 * every request (pre-token-generation copies it onto the access token).
 */
export interface MemberLoginConfig {
  readonly userPoolId: string;
}

export function readMemberLoginConfig(env: NodeJS.ProcessEnv): MemberLoginConfig {
  const userPoolId = env.COGNITO_USER_POOL_ID;
  if (!userPoolId) {
    throw new Error('COGNITO_USER_POOL_ID is required and was not set');
  }
  return { userPoolId };
}

let cachedClient: CognitoIdentityProviderClient | undefined;

export function getCognitoClient(): CognitoIdentityProviderClient {
  cachedClient ??= captureAWSv3Client(new CognitoIdentityProviderClient({}));
  return cachedClient;
}

/** Thrown when a login already exists for the email, so the caller can answer 409. */
export class MemberLoginExistsError extends Error {
  constructor(email: string) {
    super(`a login already exists for ${email}`);
    this.name = 'MemberLoginExistsError';
  }
}

/** Thrown when Cognito rejects the email itself, so the caller can answer 400. */
export class InvalidMemberEmailError extends Error {
  constructor(email: string) {
    super(`${email} is not a valid email address`);
    this.name = 'InvalidMemberEmailError';
  }
}

/** Every new member starts in the MEMBER group, matching the member row's roles. */
const INITIAL_GROUP = 'MEMBER';

/**
 * Creates the member's login (username = email; Cognito sends its invite email with a
 * temporary password) and returns its `sub`. If adding the group fails, the half-made
 * login is deleted so a retry can succeed.
 */
export async function createMemberLogin(
  client: CognitoIdentityProviderClient,
  config: MemberLoginConfig,
  input: { readonly email: string; readonly deptId: string },
): Promise<string> {
  let sub: string | undefined;
  try {
    const created = await client.send(
      new AdminCreateUserCommand({
        UserPoolId: config.userPoolId,
        Username: input.email,
        DesiredDeliveryMediums: ['EMAIL'],
        UserAttributes: [
          { Name: 'email', Value: input.email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'custom:deptId', Value: input.deptId },
        ],
      }),
    );
    sub = created.User?.Attributes?.find((attr) => attr.Name === 'sub')?.Value;
  } catch (error) {
    if (error instanceof UsernameExistsException) {
      throw new MemberLoginExistsError(input.email);
    }
    if (error instanceof InvalidParameterException) {
      throw new InvalidMemberEmailError(input.email);
    }
    throw error;
  }
  if (!sub) {
    await deleteMemberLogin(client, config, input.email);
    throw new Error('Cognito created the login but returned no sub');
  }

  try {
    await client.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: config.userPoolId,
        Username: input.email,
        GroupName: INITIAL_GROUP,
      }),
    );
  } catch (error) {
    await deleteMemberLogin(client, config, input.email);
    throw error;
  }
  return sub;
}

/**
 * A login that outlived a failed create (timeout, or the row write and the cleanup both
 * failed) answers 409 forever unless the retry can adopt it. Returns its `sub` when the login
 * belongs to `deptId` (re-adding it to MEMBER, which is idempotent); undefined when it is
 * another department's, which stays a 409.
 */
export async function adoptExistingLogin(
  client: CognitoIdentityProviderClient,
  config: MemberLoginConfig,
  input: { readonly email: string; readonly deptId: string },
): Promise<string | undefined> {
  const existing = await client.send(
    new AdminGetUserCommand({ UserPoolId: config.userPoolId, Username: input.email }),
  );
  const attribute = (name: string) =>
    existing.UserAttributes?.find((attr) => attr.Name === name)?.Value;
  const sub = attribute('sub');
  if (!sub || attribute('custom:deptId') !== input.deptId) {
    return undefined;
  }
  await client.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: config.userPoolId,
      Username: input.email,
      GroupName: INITIAL_GROUP,
    }),
  );
  if (existing.UserStatus === 'FORCE_CHANGE_PASSWORD') {
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId: config.userPoolId,
        Username: input.email,
        MessageAction: 'RESEND',
        DesiredDeliveryMediums: ['EMAIL'],
      }),
    );
  }
  return sub;
}

/** Compensation for a member that could not be written after its login was created. */
export async function deleteMemberLogin(
  client: CognitoIdentityProviderClient,
  config: MemberLoginConfig,
  username: string,
): Promise<void> {
  await client.send(
    new AdminDeleteUserCommand({ UserPoolId: config.userPoolId, Username: username }),
  );
}

export interface RoleGroupChanges {
  readonly added: readonly MemberRole[];
  readonly removed: readonly MemberRole[];
}

function isMemberRole(group: string): group is MemberRole {
  return (MEMBER_ROLES as readonly string[]).includes(group);
}

async function listRoleGroups(
  client: CognitoIdentityProviderClient,
  config: MemberLoginConfig,
  memberId: string,
): Promise<Set<MemberRole>> {
  const current = new Set<MemberRole>();
  let nextToken: string | undefined;
  do {
    const page = await client.send(
      new AdminListGroupsForUserCommand({
        UserPoolId: config.userPoolId,
        Username: memberId,
        NextToken: nextToken,
      }),
    );
    for (const group of page.Groups ?? []) {
      if (group.GroupName && isMemberRole(group.GroupName)) {
        current.add(group.GroupName);
      }
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return current;
}

/**
 * Makes the member's role groups exactly `roles` and returns what changed. The authorizer
 * and Cedar read roles from `cognito:groups`, so this is what actually grants or revokes
 * them. Username is the memberId: it is the user's `sub`, which the admin APIs accept.
 * Groups that are not one of the six roles are never touched. Safe to repeat - a retry
 * after a partial failure only applies what is still missing.
 */
export async function syncRoleGroups(
  client: CognitoIdentityProviderClient,
  config: MemberLoginConfig,
  memberId: string,
  roles: readonly MemberRole[],
): Promise<RoleGroupChanges> {
  const current = await listRoleGroups(client, config, memberId);
  const added = roles.filter((role) => !current.has(role));
  const removed = MEMBER_ROLES.filter((role) => current.has(role) && !roles.includes(role));
  for (const role of added) {
    await client.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: config.userPoolId,
        Username: memberId,
        GroupName: role,
      }),
    );
  }
  for (const role of removed) {
    await client.send(
      new AdminRemoveUserFromGroupCommand({
        UserPoolId: config.userPoolId,
        Username: memberId,
        GroupName: role,
      }),
    );
  }
  return { added, removed };
}

/**
 * Points the member's login at `email` - where Cognito sends a password-reset code (the
 * pool's recovery is verified email first). Marked verified exactly as createMemberLogin
 * provisions it: the address is attested by the chief or admin making the change, not by a
 * code round trip, so recovery works at once. The username (the email the login was created
 * with) cannot change; the member keeps signing in with it. Username is the memberId (`sub`).
 */
export async function syncMemberLoginEmail(
  client: CognitoIdentityProviderClient,
  config: MemberLoginConfig,
  memberId: string,
  email: string,
): Promise<void> {
  await client.send(
    new AdminUpdateUserAttributesCommand({
      UserPoolId: config.userPoolId,
      Username: memberId,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
    }),
  );
}

/** Ends every session of the member's login (refresh tokens); the revocation marker ends access tokens. */
export async function signOutMemberLogin(
  client: CognitoIdentityProviderClient,
  config: MemberLoginConfig,
  memberId: string,
): Promise<void> {
  await client.send(
    new AdminUserGlobalSignOutCommand({ UserPoolId: config.userPoolId, Username: memberId }),
  );
}
