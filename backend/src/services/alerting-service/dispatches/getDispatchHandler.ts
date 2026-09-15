import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { extractTraceId, withAuthorization, type GuardEvent } from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  createDynamoClient as createAlertingDynamoClient,
  readAlertingConfig,
} from '../eligibility/dynamoClient.js';
import { getPrePlanCopy, PrePlanCopyDependencyError } from '../preplan/prePlanCopyRepository.js';
import { getDynamoClient, readDispatchesConfig } from './dynamoClient.js';
import { problemResponse } from './errorResponse.js';
import { logError } from './logger.js';
import { DispatchLookupDependencyError, getDispatchById } from './repository.js';

function dispatchIdFromPath(event: GuardEvent): string {
  return event.pathParameters?.dispatchId ?? '';
}

export function createGetDispatchHandler(
  dispatchesDoc?: DynamoDBDocumentClient,
  alertingDoc?: DynamoDBDocumentClient,
  authzClient?: VerifiedPermissionsClient,
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization<APIGatewayProxyResultV2>(
    async (event, principal) => {
      const traceId = extractTraceId(event);
      const dispatchId = dispatchIdFromPath(event);
      if (!dispatchId) {
        return problemResponse({ status: 400, title: 'dispatchId is required', traceId });
      }
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
          }
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
}

export const handler = createGetDispatchHandler();
