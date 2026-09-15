import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  withAuthorization,
  extractTraceId,
  notFoundProblem,
  serviceUnavailableProblem,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError } from '../logger.js';
import type { NearestHydrant } from './nearestHydrants.js';

const METRIC_NAMESPACE = 'Boxalarm/AlertingPrePlan';

interface UtilityShutoff {
  readonly utility: string;
  readonly location: string;
}

interface PrePlanCopyItem {
  readonly summary?: string;
  readonly hazards?: readonly string[];
  readonly utilityShutoffs?: readonly UtilityShutoff[];
  readonly nearestHydrants?: readonly NearestHydrant[];
}

function occupancyIdFromPath(event: GuardEvent): string {
  return event.pathParameters?.occupancyId ?? '';
}

export function createGetPrePlanPanelHandler(
  doc?: DynamoDBDocumentClient,
  authzClient?: VerifiedPermissionsClient,
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization<APIGatewayProxyResultV2>(
    async (event, principal) => {
      const traceId = extractTraceId(event);
      const occupancyId = occupancyIdFromPath(event);
      const deptId = toVerifiedDeptId(principal);
      const { tableName } = readAlertingConfig(process.env);
      const client = createDynamoClient(process.env, doc);

      try {
        const result = await client.send(
          new GetCommand({
            TableName: tableName,
            Key: {
              pk: buildDeptScopedPk(deptId, 'PREPLAN'),
              sk: `OCCUPANCY#${occupancyId}`,
            },
          }),
        );
        const item = result.Item as PrePlanCopyItem | undefined;
        if (!item) {
          emitOutcomeMetric(METRIC_NAMESPACE, 'PrePlanPanelNotFound');
          return notFoundProblem(traceId, `No pre-plan is on file for occupancy ${occupancyId}.`);
        }
        emitOutcomeMetric(METRIC_NAMESPACE, 'PrePlanPanelServed');
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            summary: item.summary,
            hazards: item.hazards ?? [],
            utilityShutoffs: item.utilityShutoffs ?? [],
            nearestHydrants: item.nearestHydrants ?? [],
          }),
        };
      } catch (error) {
        logError({
          event: 'preplan_panel.dependency_failed',
          service: 'alerting-service',
          reason: error instanceof Error ? error.constructor.name : 'UnknownError',
          message: error instanceof Error ? error.message : undefined,
          deptId,
          occupancyId,
          traceId,
        });
        emitOutcomeMetric(METRIC_NAMESPACE, 'PrePlanPanelFailed');
        return serviceUnavailableProblem(traceId);
      }
    },
    {
      actionType: 'Action',
      actionId: 'alerting:GetPrePlanPanel',
      resourceType: 'Occupancy',
      resourceId: occupancyIdFromPath,
      ...(authzClient ? { client: authzClient } : {}),
    },
  );
}

export const handler = createGetPrePlanPanelHandler();
