import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { extractTraceId, withAuthorization, type GuardEvent } from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import {
  createDynamoClient as createAlertingDynamoClient,
  readAlertingConfig,
} from '../eligibility/dynamoClient.js';
import { getPrePlanCopy, PrePlanCopyDependencyError } from '../prePlan/prePlanCopyRepository.js';
import { getDynamoClient, readDispatchesConfig } from './dynamoClient.js';
import { problemResponse } from './errorResponse.js';
import { logError, logInfo } from './logger.js';
import { DispatchLookupDependencyError, getDispatchById } from './repository.js';

const METRIC_NAMESPACE = 'Boxalarm/AlertingPrePlanCopy';

function dispatchIdFromPath(event: GuardEvent): string {
  return event.pathParameters?.dispatchId ?? '';
}

function isValidDispatchId(dispatchId: string): boolean {
  return dispatchId.length > 0 && !dispatchId.includes('#');
}

export function createGetDispatchHandler(
  dispatchesDoc?: DynamoDBDocumentClient,
  alertingDoc?: DynamoDBDocumentClient,
  authzClient?: VerifiedPermissionsClient,
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  const authorized = withAuthorization<APIGatewayProxyResultV2>(
    async (event, principal) => {
      const traceId = extractTraceId(event);
      const dispatchId = dispatchIdFromPath(event);
      const deptId = toVerifiedDeptId(principal);

      try {
        const dispatchesConfig = readDispatchesConfig(process.env);
        const dispatchesClient = dispatchesDoc ?? getDynamoClient();
        const dispatch = await getDispatchById(
          dispatchesClient,
          dispatchesConfig.tableName,
          deptId,
          dispatchId,
        );
        if (!dispatch) {
          return problemResponse({ status: 404, title: 'Dispatch not found', traceId });
        }

        let preplan: Record<string, unknown> | undefined;
        // TODO(E1-S2): occupancyId is joined onto DISPATCH_ALERT by fan-out ingress
        // (architecture Backend §1.4); no ingress path in this repo writes it yet.
        if (dispatch.occupancyId) {
          const alertingConfig = readAlertingConfig(process.env);
          const alertingClient = alertingDoc ?? createAlertingDynamoClient(process.env);
          const copy = await getPrePlanCopy(
            alertingClient,
            alertingConfig.tableName,
            deptId,
            dispatch.occupancyId,
          );
          if (copy) {
            preplan = {
              summary: copy.summary,
              hazards: copy.hazards,
              utilityShutoffs: copy.utilityShutoffs,
              nearestHydrants: copy.nearestHydrants,
            };
          } else {
            logInfo('dispatches.get.enrichment_copy_not_found', { deptId, dispatchId, traceId });
            emitOutcomeMetric(METRIC_NAMESPACE, 'EnrichmentCopyNotFound');
          }
        } else {
          logInfo('dispatches.get.enrichment_absent_occupancy_id', {
            deptId,
            dispatchId,
            traceId,
          });
          emitOutcomeMetric(METRIC_NAMESPACE, 'EnrichmentAbsentOccupancyId');
        }

        // TODO: E1-S6 extend with core alert content + toneLadder per architecture §2
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            dispatchId: dispatch.dispatchId,
            ...(preplan ? { preplan } : {}),
          }),
        };
      } catch (error) {
        if (
          error instanceof DispatchLookupDependencyError ||
          error instanceof PrePlanCopyDependencyError
        ) {
          logError('dispatches.get.dependency_unavailable', error, {
            deptId,
            dispatchId,
            traceId,
          });
          return problemResponse({ status: 503, title: 'Service unavailable', traceId });
        }
        logError('dispatches.get.unhandled_error', error, { deptId, dispatchId, traceId });
        throw error;
      }
    },
    {
      actionType: 'Action',
      actionId: 'alerting:GetDispatch',
      resourceType: 'Dispatch',
      resourceId: dispatchIdFromPath,
      ...(authzClient ? { client: authzClient } : {}),
    },
  );

  return async (event) => {
    const traceId = extractTraceId(event);
    const dispatchId = dispatchIdFromPath(event);
    if (!isValidDispatchId(dispatchId)) {
      return problemResponse({ status: 400, title: 'dispatchId is required', traceId });
    }
    return authorized(event);
  };
}

export const handler = createGetDispatchHandler();
