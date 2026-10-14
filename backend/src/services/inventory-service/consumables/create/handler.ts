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
import { ValidationError, parseJsonBody, toProblemResponse } from '../../lib/problemDetails.js';
import { createConsumable } from '../consumableRepository.js';

const MAX_TEXT_LENGTH = 200;

function parseNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} is required and must be a non-negative integer`);
  }
  return value;
}

function parseText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > MAX_TEXT_LENGTH) {
    throw new ValidationError(`${field} must be at most ${MAX_TEXT_LENGTH} characters`);
  }
  return text;
}

export function createCreateConsumableHandler(docClient?: DynamoDBDocumentClient) {
  return async function innerHandler(
    event: GuardEvent,
    principal: CedarPrincipalContext,
  ): Promise<APIGatewayProxyResultV2> {
    const correlationId = extractTraceId(event);
    try {
      const deptId = toVerifiedDeptId(principal);
      const actorId = principal.sub;

      const body = parseJsonBody(event.body);
      const itemName = parseText(body.itemName, 'itemName');
      if (!itemName) {
        throw new ValidationError('itemName is required and must be a non-empty string');
      }
      const stockLevel = parseNonNegativeNumber(body.stockLevel, 'stockLevel');
      const reorderThreshold = parseNonNegativeNumber(body.reorderThreshold, 'reorderThreshold');
      const location = parseText(body.location, 'location');

      const client = getDocClient(docClient);
      const { tableName } = readInventoryConfig(process.env);
      const consumable = await createConsumable(client, tableName, deptId, actorId, {
        itemName,
        stockLevel,
        reorderThreshold,
        ...(location ? { location } : {}),
      });

      emitMetric('ConsumableStockCreated');
      return {
        statusCode: 201,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(consumable),
      };
    } catch (error) {
      logEvent('error', {
        event: 'inventory.consumables.create.failed',
        correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
      emitMetric('ConsumableStockCreateFailed');
      return toProblemResponse(error, event.rawPath, correlationId);
    }
  };
}

export function createHandler(deps?: {
  readonly authzClient?: WithAuthorizationOptions['client'];
  readonly dynamoClient?: DynamoDBDocumentClient;
}): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(createCreateConsumableHandler(deps?.dynamoClient), {
    actionType: 'Boxalarm::Action',
    actionId: 'CreateConsumable',
    resourceType: 'Boxalarm::Department',
    resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
    ...(deps?.authzClient ? { client: deps.authzClient } : {}),
  });
}

export const handler = createHandler();
