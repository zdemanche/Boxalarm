import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
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
  CompartmentItemStoreUnavailableError,
  listCompartmentItems,
  type CompartmentItemRecord,
} from '../inventory/compartmentItemRepository.js';
import { extractTraceId } from '../inventory/traceId.js';

interface CompartmentGroup {
  readonly compartmentCode: string;
  readonly items: readonly { itemId: string; itemName: string; quantity: number }[];
}

function groupByCompartment(items: readonly CompartmentItemRecord[]): CompartmentGroup[] {
  const byCode = new Map<string, CompartmentGroup['items'][number][]>();
  for (const item of items) {
    const existing = byCode.get(item.compartmentCode) ?? [];
    existing.push({ itemId: item.itemId, itemName: item.itemName, quantity: item.quantity });
    byCode.set(item.compartmentCode, existing);
  }
  return [...byCode.entries()].map(([compartmentCode, groupItems]) => ({
    compartmentCode,
    items: groupItems,
  }));
}

export async function listInventory(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event.headers);
  const unitId = event.pathParameters?.unitId;
  if (!unitId) {
    return badRequestProblem(traceId, 'unitId path parameter is required');
  }

  let deptId: VerifiedDeptId;
  try {
    deptId = toVerifiedDeptId(principal);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'inventory.list.invalidDeptId',
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
    const items = await listCompartmentItems(client, tableName, deptId, unitId);
    emitInventoryMetric('List', 'Success');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ compartments: groupByCompartment(items) }),
    };
  } catch (error) {
    if (error instanceof CompartmentItemInvalidKeyError) {
      emitInventoryMetric('List', 'Failure', 'InvalidKey');
      return badRequestProblem(traceId, error.message);
    }
    if (error instanceof CompartmentItemStoreUnavailableError) {
      emitInventoryMetric('List', 'Failure', error.reason);
      return serviceUnavailableProblem(traceId);
    }
    console.error(
      JSON.stringify({
        event: 'inventory.list.unexpectedError',
        service: 'apparatus-service',
        deptId,
        unitId,
        traceId,
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    throw error;
  }
}

export const handler = withAuthorization(listInventory, {
  actionType: 'Boxalarm::Action',
  actionId: 'ListCompartmentInventory',
  resourceType: 'Boxalarm::Apparatus',
  resourceId: (event) => event.pathParameters?.unitId ?? '',
});
