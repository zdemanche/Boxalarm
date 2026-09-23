import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  notFoundProblem,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { readPlatformTableConfig } from '../inventory/config.js';
import { getDynamoDocumentClient } from '../inventory/dynamoClient.js';
import { emitInventoryMetric } from '../inventory/metrics.js';
import {
  CompartmentItemInvalidKeyError,
  CompartmentItemNotFoundError,
  CompartmentItemStoreUnavailableError,
  updateCompartmentItemQuantity,
} from '../inventory/compartmentItemRepository.js';
import { extractTraceId } from '../inventory/traceId.js';

function parseQuantityBody(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const { quantity } = parsed as Record<string, unknown>;
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 0) {
    return undefined;
  }
  return quantity;
}

export async function updateInventoryQuantity(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event.headers);
  const unitId = event.pathParameters?.unitId;
  const itemId = event.pathParameters?.itemId;
  if (!unitId || !itemId) {
    return badRequestProblem(traceId, 'unitId and itemId path parameters are required');
  }

  const quantity = parseQuantityBody(event.body);
  if (quantity === undefined) {
    return badRequestProblem(traceId, 'a non-negative integer quantity is required');
  }

  let deptId: VerifiedDeptId;
  try {
    deptId = toVerifiedDeptId(principal);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'inventory.updateQuantity.invalidDeptId',
        service: 'apparatus-service',
        traceId,
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    return badRequestProblem(
      traceId,
      'the authenticated principal has an invalid department scope',
    );
  }

  try {
    const { tableName } = readPlatformTableConfig(process.env);
    const client = getDynamoDocumentClient();
    await updateCompartmentItemQuantity(
      client,
      tableName,
      deptId,
      unitId,
      itemId,
      quantity,
      principal.sub,
    );
    emitInventoryMetric('Update', 'Success');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId, quantity }),
    };
  } catch (error) {
    if (error instanceof CompartmentItemNotFoundError) {
      emitInventoryMetric('Update', 'Failure', 'NotFound');
      return notFoundProblem(traceId, error.message);
    }
    if (error instanceof CompartmentItemInvalidKeyError) {
      emitInventoryMetric('Update', 'Failure', 'InvalidKey');
      return badRequestProblem(traceId, error.message);
    }
    if (error instanceof CompartmentItemStoreUnavailableError) {
      emitInventoryMetric('Update', 'Failure', error.reason);
      return serviceUnavailableProblem(traceId);
    }
    console.error(
      JSON.stringify({
        event: 'inventory.updateQuantity.unexpectedError',
        service: 'apparatus-service',
        deptId,
        unitId,
        itemId,
        traceId,
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    throw error;
  }
}

export const handler = withAuthorization(updateInventoryQuantity, {
  actionType: 'Boxalarm::Action',
  actionId: 'UpdateCompartmentItemQuantity',
  resourceType: 'Boxalarm::Apparatus',
  resourceId: (event) => event.pathParameters?.unitId ?? '',
});
