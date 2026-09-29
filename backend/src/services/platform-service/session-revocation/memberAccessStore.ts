import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';

export function readPlatformTableName(env: NodeJS.ProcessEnv): string {
  const tableName = env.PLATFORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return tableName;
}

let cachedDocClient: DynamoDBDocumentClient | undefined;

export function getAccessStoreClient(override?: DynamoDBDocumentClient): DynamoDBDocumentClient {
  if (override) {
    return override;
  }
  cachedDocClient ??= DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient({})));
  return cachedDocClient;
}

/**
 * The member row's current status, or undefined when there is no row. Session revocation
 * acts on this rather than on the status an event carries: the queue is standard SQS and a
 * batch is processed concurrently, so LOA -> ACTIVE in quick succession can be handled out
 * of order. Acting on the event would leave a returned member disabled (or a member on
 * leave enabled); acting on the row converges on the latest write whatever the order.
 */
export async function readMemberStatus(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: string,
  memberId: string,
): Promise<string | undefined> {
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        pk: buildDeptScopedPk(toVerifiedDeptId({ deptId }), 'MEMBER', memberId),
        sk: 'METADATA',
      },
      ProjectionExpression: '#status',
      ExpressionAttributeNames: { '#status': 'status' },
      ConsistentRead: true,
    }),
  );
  const status: unknown = result.Item?.status;
  return typeof status === 'string' ? status : undefined;
}
