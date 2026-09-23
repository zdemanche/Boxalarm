import {
  Decision,
  IsAuthorizedWithTokenCommand,
  VerifiedPermissionsClient,
} from '@aws-sdk/client-verifiedpermissions';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { logStructuredError } from './log.js';
import type { OccupancyAuthorizationConfig } from './config.js';

export class ForbiddenError extends Error {}
export class ServiceUnavailableError extends Error {}

// TODO: E8-S3 — action/resource-type literals are placeholders until the occupancy Cedar
// policy schema ships; update to match the real schema once that ticket lands.
const OCCUPANCY_WRITE_ACTION_ID = 'WriteOccupancy';
const OCCUPANCY_RESOURCE_TYPE = 'Boxalarm::Occupancy';

let cachedClient: VerifiedPermissionsClient | undefined;

function getVerifiedPermissionsClient(): VerifiedPermissionsClient {
  cachedClient ??= captureAWSv3Client(new VerifiedPermissionsClient({}));
  return cachedClient;
}

export async function assertOccupancyWriteAuthorized(
  config: OccupancyAuthorizationConfig,
  bearerToken: string,
  occupancyId: string,
  traceId: string,
): Promise<void> {
  let decision: Decision | undefined;
  try {
    const client = getVerifiedPermissionsClient();
    const result = await client.send(
      new IsAuthorizedWithTokenCommand({
        policyStoreId: config.policyStoreId,
        accessToken: bearerToken,
        action: { actionType: 'Action', actionId: OCCUPANCY_WRITE_ACTION_ID },
        resource: { entityType: OCCUPANCY_RESOURCE_TYPE, entityId: occupancyId },
      }),
    );
    decision = result.decision;
  } catch (error) {
    logStructuredError('occupancy.authorization.error', traceId, {
      occupancyId,
      message: error instanceof Error ? error.message : undefined,
    });
    throw new ServiceUnavailableError('Verified Permissions is unavailable');
  }
  if (decision !== Decision.ALLOW) {
    throw new ForbiddenError('occupancy write is not authorized');
  }
}
