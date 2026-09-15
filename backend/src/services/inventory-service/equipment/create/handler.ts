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
import { ValidationError, requireAdminGroup, toProblemResponse } from '../../lib/problemDetails.js';
import { createEquipmentAsset } from '../equipmentRepository.js';

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
    const deptId = toVerifiedDeptId(event.requestContext.authorizer.lambda);
    const actorId = event.requestContext.authorizer.lambda.sub;

    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const serialNumber = typeof body.serialNumber === 'string' ? body.serialNumber.trim() : '';
    if (!serialNumber) {
      throw new ValidationError('serialNumber is required and must be a non-empty string');
    }
    const location = typeof body.location === 'string' ? body.location.trim() : '';

    const client = getDocClient(docClient);
    const { tableName } = readInventoryConfig(env);
    const asset = await createEquipmentAsset(client, tableName, deptId, actorId, {
      serialNumber,
      location,
    });

    emitMetric('EquipmentAssetCreated');
    return {
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(asset),
    };
  } catch (error) {
    logEvent('error', {
      event: 'inventory.equipment.create.failed',
      correlationId,
      message: error instanceof Error ? error.message : String(error),
    });
    emitMetric('EquipmentAssetCreateFailed');
    return toProblemResponse(error, event.rawPath, correlationId);
  }
}
