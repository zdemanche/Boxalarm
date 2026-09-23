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
import { setAssignment, type AssignedToType } from '../equipmentRepository.js';

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;

function isAssignedToType(value: unknown): value is AssignedToType {
  return value === 'MEMBER' || value === 'APPARATUS';
}

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
    const assignedToType = body.assignedToType;
    const assignedToId = typeof body.assignedToId === 'string' ? body.assignedToId.trim() : '';
    if (!isAssignedToType(assignedToType)) {
      throw new ValidationError('assignedToType must be MEMBER or APPARATUS');
    }
    if (!assignedToId) {
      throw new ValidationError('assignedToId is required and must be a non-empty string');
    }

    const client = getDocClient(docClient);
    const { tableName } = readInventoryConfig(env);
    const asset = await setAssignment(
      client,
      tableName,
      deptId,
      actorId,
      assetId,
      assignedToType,
      assignedToId,
    );
    if (!asset) {
      throw new NotFoundError(`equipment asset ${assetId} was not found`);
    }

    emitMetric('EquipmentAssetAssigned');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(asset),
    };
  } catch (error) {
    logEvent('error', {
      event: 'inventory.equipment.assignment.failed',
      correlationId,
      message: error instanceof Error ? error.message : String(error),
    });
    emitMetric('EquipmentAssetAssignFailed');
    return toProblemResponse(error, event.rawPath, correlationId);
  }
}
