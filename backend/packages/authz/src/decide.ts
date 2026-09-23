import {
  BatchIsAuthorizedWithTokenCommand,
  Decision,
  IsAuthorizedWithTokenCommand,
  type VerifiedPermissionsClient,
} from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPrincipal } from '@boxalarm/dept-scope';
import type { AuthzConfig } from './client.js';

export interface CedarPrincipalContext extends VerifiedPrincipal {
  readonly sub: string;
  readonly 'cognito:groups': string;
}

export interface CedarAction {
  readonly actionType: string;
  readonly actionId: string;
  readonly resourceType: string;
  readonly resourceId: string;
}

export interface BatchResourceDecision {
  readonly resourceId: string;
  readonly allowed: boolean;
}

export class AuthzUnavailableError extends Error {
  readonly reason: string;

  constructor(cause: unknown) {
    super('Verified Permissions is unavailable or returned an unexpected error');
    this.name = 'AuthzUnavailableError';
    this.cause = cause;
    // aws-sdk VP client errors don't set a stable .name either — capture the constructor
    // name (mirrors the same caveat already documented for aws-jwt-verify in handler.ts)
    // so a 503 can be logged with a reason that survives minified bundling.
    this.reason = cause instanceof Error ? cause.constructor.name : 'UnknownError';
  }
}

export async function isAuthorized(
  client: VerifiedPermissionsClient,
  config: AuthzConfig,
  accessToken: string,
  action: CedarAction,
): Promise<boolean> {
  try {
    const output = await client.send(
      new IsAuthorizedWithTokenCommand({
        policyStoreId: config.policyStoreId,
        accessToken,
        action: { actionType: action.actionType, actionId: action.actionId },
        resource: { entityType: action.resourceType, entityId: action.resourceId },
      }),
    );
    return output.decision === Decision.ALLOW;
  } catch (error) {
    throw new AuthzUnavailableError(error);
  }
}

export async function batchIsAuthorized(
  client: VerifiedPermissionsClient,
  config: AuthzConfig,
  accessToken: string,
  actionType: string,
  actionId: string,
  resourceType: string,
  resourceIds: readonly string[],
): Promise<readonly BatchResourceDecision[]> {
  resourceIds.forEach((resourceId, index) => {
    if (typeof resourceId !== 'string' || resourceId.length === 0) {
      throw new TypeError(
        `resourceIds[${index}] must be a non-empty string, received ${JSON.stringify(resourceId)}`,
      );
    }
  });
  if (resourceIds.length === 0) {
    return [];
  }

  let results;
  try {
    const output = await client.send(
      new BatchIsAuthorizedWithTokenCommand({
        policyStoreId: config.policyStoreId,
        accessToken,
        requests: resourceIds.map((resourceId) => ({
          action: { actionType, actionId },
          resource: { entityType: resourceType, entityId: resourceId },
        })),
      }),
    );
    results = output.results ?? [];
  } catch (error) {
    throw new AuthzUnavailableError(error);
  }

  // BatchIsAuthorizedWithToken returns results in request order, so zip against the
  // original resourceIds rather than trust the optional echoed request.resource.entityId.
  return resourceIds.map((resourceId, index) => ({
    resourceId,
    allowed: results[index]?.decision === Decision.ALLOW,
  }));
}
