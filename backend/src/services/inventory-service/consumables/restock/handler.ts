import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  extractTraceId,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
  type WithAuthorizationOptions,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { getDocClient, readInventoryConfig } from '../../lib/dynamoDb.js';
import { emitMetric, logEvent } from '../../lib/logger.js';
import { NotFoundError, ValidationError, toProblemResponse } from '../../lib/problemDetails.js';
import { restockConsumable, type RestockConsumableInput } from '../consumableRepository.js';

function parseNonNegativeNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative number`);
  }
  return value;
}

export function createRestockHandler(docClient?: DynamoDBDocumentClient) {
  return async function innerHandler(
    event: GuardEvent,
    principal: CedarPrincipalContext,
  ): Promise<APIGatewayProxyResultV2> {
    const correlationId = extractTraceId(event);
    try {
      const itemId = event.pathParameters?.itemId;
      if (!itemId) {
        throw new ValidationError('itemId path parameter is required');
      }
      const deptId = toVerifiedDeptId(principal);
      const actorId = principal.sub;

      const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
      const stockLevel = parseNonNegativeNumber(body.stockLevel, 'stockLevel');
      const reorderThreshold = parseNonNegativeNumber(body.reorderThreshold, 'reorderThreshold');
      if (stockLevel === undefined && reorderThreshold === undefined) {
        throw new ValidationError('at least one of stockLevel or reorderThreshold is required');
      }
      const input: RestockConsumableInput = {
        ...(stockLevel !== undefined ? { stockLevel } : {}),
        ...(reorderThreshold !== undefined ? { reorderThreshold } : {}),
      };

      const client = getDocClient(docClient);
      const { tableName } = readInventoryConfig(process.env);
      const consumable = await restockConsumable(
        client,
        tableName,
        deptId,
        actorId,
        itemId,
        input,
      );
      if (!consumable) {
        throw new NotFoundError(`consumable item ${itemId} was not found`);
      }

      emitMetric('ConsumableStockRestocked');
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(consumable),
      };
    } catch (error) {
      logEvent('error', {
        event: 'inventory.consumables.restock.failed',
        correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
      return toProblemResponse(error, event.rawPath, correlationId);
    }
  };
}

export function createHandler(deps?: {
  readonly authzClient?: WithAuthorizationOptions['client'];
  readonly dynamoClient?: DynamoDBDocumentClient;
}): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(createRestockHandler(deps?.dynamoClient), {
    actionType: 'Boxalarm::Action',
    actionId: 'RestockConsumable',
    resourceType: 'Boxalarm::Asset',
    resourceId: (event) => event.pathParameters?.itemId ?? '',
    ...(deps?.authzClient ? { client: deps.authzClient } : {}),
  });
}

export const handler = createHandler();
