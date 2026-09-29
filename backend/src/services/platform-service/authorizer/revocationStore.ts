import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';

/**
 * Per-member session revocation marker (review M1). Access tokens are verified offline, so a
 * global sign-out leaves every already-issued access token valid for up to its 1-hour
 * lifetime. The authorizer rejects any token issued at or before the member's `revokedAt`.
 * One row per member, overwritten by each revocation: DEPT#{deptId}#SESSION_REVOCATION#{sub}.
 */
export const REVOCATION_ENTITY = 'SESSION_REVOCATION';

export type RevocationReason = 'MEMBER_STATUS' | 'DEVICE_LOSS' | 'CREDENTIAL_RESET';

function revocationKey(deptId: string, sub: string): { pk: string; sk: string } {
  return {
    pk: buildDeptScopedPk(toVerifiedDeptId({ deptId }), REVOCATION_ENTITY, sub),
    sk: 'METADATA',
  };
}

export interface RevocationMarkerInput {
  readonly deptId: string;
  readonly sub: string;
  readonly reason: RevocationReason;
  readonly actorId?: string | undefined;
}

/** Writes the marker and returns revokedAt (epoch seconds). */
export async function writeRevocationMarker(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  input: RevocationMarkerInput,
  nowMs: number = Date.now(),
): Promise<number> {
  const revokedAt = Math.floor(nowMs / 1000);
  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        ...revocationKey(input.deptId, input.sub),
        entityType: 'SESSION_REVOCATION',
        revokedAt,
        reason: input.reason,
        ...(input.actorId ? { actorId: input.actorId } : {}),
        updatedAt: nowMs,
      },
    }),
  );
  return revokedAt;
}

export async function readRevokedAt(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: string,
  sub: string,
): Promise<number | undefined> {
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: revocationKey(deptId, sub),
      ProjectionExpression: 'revokedAt',
    }),
  );
  const revokedAt: unknown = result.Item?.revokedAt;
  return typeof revokedAt === 'number' ? revokedAt : undefined;
}

let cachedAuthorizerClient: DynamoDBDocumentClient | undefined;

/**
 * The authorizer's client: ONE attempt with tight timeouts. It sits in front of every route,
 * including responding to a call, so a slow table must surface as "unavailable" (handled by
 * the fail-open/fail-closed rule in revocationCheck.ts) within a bounded time rather than
 * holding the request through the SDK's default retries.
 */
export function getAuthorizerStoreClient(): DynamoDBDocumentClient {
  cachedAuthorizerClient ??= DynamoDBDocumentClient.from(
    captureAWSv3Client(
      new DynamoDBClient({
        maxAttempts: 1,
        requestHandler: { connectionTimeout: 200, requestTimeout: 400 },
      }),
    ),
  );
  return cachedAuthorizerClient;
}
