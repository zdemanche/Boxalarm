import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { problemResponse, type ProblemResponse } from './authContext.js';

/**
 * Officer review lock. While `lockedAt` is set on the incident METADATA row every edit
 * route answers 409; only an admin or chief can unlock, with a reason (unlockIncident.ts).
 *
 * The lock is enforced twice: each handler checks the row it loaded (a clear 409 before any
 * work), and every edit write carries {@link NOT_LOCKED_CONDITION} on the METADATA row in
 * the same transaction, so a lock that lands between the read and the write still wins.
 */

export const NOT_LOCKED_CONDITION = 'attribute_not_exists(lockedAt)';

export class IncidentLockedError extends Error {
  constructor(incidentId: string) {
    super(`incident "${incidentId}" is locked for review and cannot be edited`);
    this.name = 'IncidentLockedError';
  }
}

export function lockedProblem(traceId: string): ProblemResponse {
  return problemResponse(
    409,
    'Conflict',
    'This report is locked for officer review. An admin or chief must unlock it, with a reason, before it can be edited.',
    traceId,
    { code: 'INCIDENT_LOCKED' },
  );
}

/**
 * After a write whose METADATA condition (`attribute_exists(pk) AND <not locked>`) failed,
 * reads the row to say which half failed: missing (`'missing'`) or locked (`'locked'`).
 */
export async function explainMetadataConditionFailure(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  incidentId: string,
): Promise<'missing' | 'locked'> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId), sk: 'METADATA' },
      ConsistentRead: true,
    }),
  );
  return result.Item && typeof result.Item.lockedAt === 'number' ? 'locked' : 'missing';
}
