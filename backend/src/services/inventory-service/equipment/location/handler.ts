import { randomUUID } from 'node:crypto';
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../../../platform-service/authorizer/handler.js';
import { getDocClient, readInventoryConfig } from '../../lib/dynamoDb.js';
import { emitMetric, logEvent } from '../../lib/logger.js';
import {
  NotFoundError,
  ValidationError,
  requireAdminGroup,
  toProblemResponse,
} from '../../lib/problemDetails.js';
import { setLocation } from '../equipmentRepository.js';

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
    requireAdminGroup(event.requestContext.authorizer.lambda);
    const assetId = event.pathParameters?.assetId;
    if (!assetId) {
      throw new ValidationError('assetId path parameter is required');
    }
    const deptId = toVerifiedDeptId(event.requestContext.authorizer.lambda);
    const actorId = event.requestContext.authorizer.lambda.sub;

    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const location = typeof body.location === 'string' ? body.location.trim() : '';
    if (!location) {
      throw new ValidationError('location is required and must be a non-empty string');
    }

    const client = getDocClient(docClient);
    const { tableName } = readInventoryConfig(env);
    const asset = await setLocation(client, tableName, deptId, actorId, assetId, location);
    if (!asset) {
      throw new NotFoundError(`equipment asset ${assetId} was not found`);
    }

    emitMetric('EquipmentAssetLocationUpdated');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(asset),
    };
  } catch (error) {
    logEvent('error', {
      event: 'inventory.equipment.location.failed',
      correlationId,
      message: error instanceof Error ? error.message : String(error),
    });
    return toProblemResponse(error, event.rawPath, correlationId);
  }
}
