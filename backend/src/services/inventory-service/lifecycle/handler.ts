import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
  type WithAuthorizationOptions,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  assetNotFoundProblem,
  invalidLifecycleRequestProblem,
  invalidLifecycleTransitionProblem,
} from './problemDetails.js';
import { emitInventoryMetric } from './metrics.js';
import {
  LIFECYCLE_TRANSITIONS,
  LifecycleTransitionConflictError,
  createInventoryDynamoClient,
  getEquipmentAsset,
  readInventoryConfig,
  transitionLifecycleStatus,
  type LifecycleStatus,
} from './repository.js';

const TARGET_STATUSES: readonly LifecycleStatus[] = ['IN_SERVICE', 'RETIRED'];

function parseTargetStatus(body: string | null | undefined): LifecycleStatus | undefined {
  if (!body) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const target = (parsed as Record<string, unknown>).lifecycleStatus;
  return typeof target === 'string' && (TARGET_STATUSES as readonly string[]).includes(target)
    ? (target as LifecycleStatus)
    : undefined;
}

export function createLifecycleHandler(dynamoClient?: DynamoDBDocumentClient) {
  return async function innerHandler(
    event: GuardEvent,
    principal: CedarPrincipalContext,
  ): Promise<APIGatewayProxyResultV2> {
    const traceId = extractTraceId(event);
    const assetId = event.pathParameters?.assetId;
    if (!assetId) {
      emitInventoryMetric('AssetLifecycleTransitionFailed', 'MissingAssetId');
      return invalidLifecycleRequestProblem(traceId, 'pathParameters.assetId is required');
    }
    if (assetId.includes('#')) {
      emitInventoryMetric('AssetLifecycleTransitionFailed', 'InvalidAssetId');
      return invalidLifecycleRequestProblem(traceId, 'pathParameters.assetId must not contain "#"');
    }

    const target = parseTargetStatus(event.body);
    if (!target) {
      emitInventoryMetric('AssetLifecycleTransitionFailed', 'InvalidRequestBody');
      return invalidLifecycleRequestProblem(
        traceId,
        'lifecycleStatus is required and must be "IN_SERVICE" or "RETIRED"',
      );
    }

    const deptId = toVerifiedDeptId(principal);

    try {
      const client = createInventoryDynamoClient(process.env, dynamoClient);
      const config = readInventoryConfig(process.env);

      const asset = await getEquipmentAsset(client, config, deptId, assetId);
      if (!asset) {
        emitInventoryMetric('AssetLifecycleTransitionFailed', 'AssetNotFound');
        return assetNotFoundProblem(traceId, assetId);
      }

      const allowedTransitions = LIFECYCLE_TRANSITIONS[asset.lifecycleStatus] ?? [];
      if (!allowedTransitions.includes(target)) {
        emitInventoryMetric('AssetLifecycleTransitionFailed', 'InvalidTransition');
        return invalidLifecycleTransitionProblem(
          traceId,
          `Cannot transition asset "${assetId}" from "${asset.lifecycleStatus}" to "${target}".`,
        );
      }

      const updated = await transitionLifecycleStatus(
        client,
        config,
        deptId,
        assetId,
        asset.lifecycleStatus,
        target,
      );
      emitInventoryMetric('AssetLifecycleTransitioned');
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updated),
      };
    } catch (error) {
      if (error instanceof LifecycleTransitionConflictError) {
        console.error(
          JSON.stringify({
            event: 'inventory.lifecycle.conflict',
            service: 'inventory',
            reason: error.constructor.name,
            correlationId: traceId,
            deptId,
          }),
        );
        emitInventoryMetric('AssetLifecycleTransitionFailed', 'ConcurrentTransition');
        return invalidLifecycleTransitionProblem(traceId, error.message);
      }
      const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
      console.error(
        JSON.stringify({
          event: 'inventory.lifecycle.error',
          service: 'inventory',
          reason,
          correlationId: traceId,
          deptId,
        }),
      );
      emitInventoryMetric('AssetLifecycleTransitionFailed', reason);
      return serviceUnavailableProblem(traceId);
    }
  };
}

export function createHandler(deps?: {
  readonly authzClient?: WithAuthorizationOptions['client'];
  readonly dynamoClient?: DynamoDBDocumentClient;
}): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(createLifecycleHandler(deps?.dynamoClient), {
    actionType: 'Boxalarm::Action',
    actionId: 'TransitionAssetLifecycle',
    resourceType: 'Boxalarm::Asset',
    resourceId: (event) => event.pathParameters?.assetId ?? '',
    ...(deps?.authzClient ? { client: deps.authzClient } : {}),
  });
}

export const handler = createHandler();
