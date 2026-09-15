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
import { NotFoundError, ValidationError, toProblemResponse } from '../../lib/problemDetails.js';
import { getEquipmentAsset } from '../equipmentRepository.js';

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
    const assetId = event.pathParameters?.assetId;
    if (!assetId) {
      throw new ValidationError('assetId path parameter is required');
    }
    const deptId = toVerifiedDeptId(event.requestContext.authorizer.lambda);

    const client = getDocClient(docClient);
    const { tableName } = readInventoryConfig(env);
    const asset = await getEquipmentAsset(client, tableName, deptId, assetId);
    if (!asset) {
      throw new NotFoundError(`equipment asset ${assetId} was not found`);
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(asset),
    };
  } catch (error) {
    logEvent('error', {
      event: 'inventory.equipment.get.failed',
      correlationId,
      message: error instanceof Error ? error.message : String(error),
    });
    return toProblemResponse(error, event.rawPath, correlationId);
  }
}
