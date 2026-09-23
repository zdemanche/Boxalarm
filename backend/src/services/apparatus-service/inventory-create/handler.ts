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
  putCompartmentItem,
  type CompartmentItemInput,
} from '../inventory/compartmentItemRepository.js';
import { extractTraceId } from '../inventory/traceId.js';

function parseCreateBody(raw: string | undefined): CompartmentItemInput | undefined {
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
  const { compartmentCode, itemName, quantity } = parsed as Record<string, unknown>;
  if (typeof compartmentCode !== 'string' || compartmentCode.trim().length === 0) {
    return undefined;
  }
  if (typeof itemName !== 'string' || itemName.trim().length === 0) {
    return undefined;
  }
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 0) {
    return undefined;
  }
  return { compartmentCode, itemName, quantity };
}

export async function createInventoryItem(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event.headers);
  const unitId = event.pathParameters?.unitId;
  if (!unitId) {
    return badRequestProblem(traceId, 'unitId path parameter is required');
  }

  const input = parseCreateBody(event.body);
  if (!input) {
    return badRequestProblem(
      traceId,
      'compartmentCode, itemName, and a non-negative integer quantity are required',
    );
  }

  let deptId: VerifiedDeptId;
  try {
    deptId = toVerifiedDeptId(principal);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'inventory.create.invalidDeptId',
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
    const created = await putCompartmentItem(
      client,
      tableName,
      deptId,
      unitId,
      input,
      principal.sub,
    );
    emitInventoryMetric('Create', 'Success');
    return {
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(created),
    };
  } catch (error) {
    if (error instanceof CompartmentItemInvalidKeyError) {
      emitInventoryMetric('Create', 'Failure', 'InvalidKey');
      return badRequestProblem(traceId, error.message);
    }
    if (error instanceof CompartmentItemStoreUnavailableError) {
      emitInventoryMetric('Create', 'Failure', error.reason);
      return serviceUnavailableProblem(traceId);
    }
    console.error(
      JSON.stringify({
        event: 'inventory.create.unexpectedError',
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

export const handler = withAuthorization(createInventoryItem, {
  actionType: 'Boxalarm::Action',
  actionId: 'CreateCompartmentItem',
  resourceType: 'Boxalarm::Apparatus',
  resourceId: (event) => event.pathParameters?.unitId ?? '',
});
