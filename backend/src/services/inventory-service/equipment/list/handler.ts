import { randomUUID } from 'node:crypto';
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../../../platform-service/authorizer/handler.js';
import { getDocClient, readInventoryConfig } from '../../lib/dynamoDb.js';
import { logEvent } from '../../lib/logger.js';
import { toProblemResponse } from '../../lib/problemDetails.js';
import { listEquipmentAssets, type ListEquipmentAssetsFilter } from '../equipmentRepository.js';

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;

export async function handler(
  event: Event,
  _context: unknown = undefined,
  _callback: unknown = undefined,
  env: NodeJS.ProcessEnv = process.env,
  docClient?: DynamoDBDocumentClient,
): Promise<APIGatewayProxyStructuredResultV2> {
  void _context;
  void _callback;
  const correlationId = event.requestContext.requestId ?? randomUUID();
  try {
    const deptId = toVerifiedDeptId(event.requestContext.authorizer.lambda);
    const assignedToTypeParam = event.queryStringParameters?.assignedToType;
    const assignedToId = event.queryStringParameters?.assignedToId;
    const filter: ListEquipmentAssetsFilter = {
      ...(assignedToTypeParam === 'MEMBER' || assignedToTypeParam === 'APPARATUS'
        ? { assignedToType: assignedToTypeParam }
        : {}),
      ...(assignedToId ? { assignedToId } : {}),
    };

    const client = getDocClient(docClient);
    const { tableName } = readInventoryConfig(env);
    const items = await listEquipmentAssets(client, tableName, deptId, filter);

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    };
  } catch (error) {
    logEvent('error', {
      event: 'inventory.equipment.list.failed',
      correlationId,
      message: error instanceof Error ? error.message : String(error),
    });
    return toProblemResponse(error, event.rawPath, correlationId);
  }
}
