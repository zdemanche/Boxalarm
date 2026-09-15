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
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { invalidPpeRequestProblem } from '../problemDetails.js';
import {
  createInventoryDynamoClient,
  listPpeAssignmentsForMember,
  readInventoryConfig,
} from '../repository.js';

const METRIC_NAMESPACE = 'Boxalarm/Ppe';

export function createGetPpeHandler(dynamoClient?: DynamoDBDocumentClient) {
  return async function innerHandler(
    event: GuardEvent,
    principal: CedarPrincipalContext,
  ): Promise<APIGatewayProxyResultV2> {
    const traceId = extractTraceId(event);
    const memberId = event.pathParameters?.memberId;
    if (!memberId) {
      emitOutcomeMetric(METRIC_NAMESPACE, 'PpeViewFailed', 'MissingMemberId');
      return invalidPpeRequestProblem(traceId, 'pathParameters.memberId is required');
    }
    if (memberId.includes('#')) {
      emitOutcomeMetric(METRIC_NAMESPACE, 'PpeViewFailed', 'InvalidMemberId');
      return invalidPpeRequestProblem(traceId, 'pathParameters.memberId must not contain "#"');
    }

    const deptId = toVerifiedDeptId(principal);

    try {
      const client = createInventoryDynamoClient(process.env, dynamoClient);
      const config = readInventoryConfig(process.env);

      const assignments = await listPpeAssignmentsForMember(client, config, {
        deptId,
        memberId,
        correlationId: traceId,
        now: new Date(),
      });

      emitOutcomeMetric(METRIC_NAMESPACE, 'PpeViewed');
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(assignments),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
      console.error(
        JSON.stringify({
          event: 'inventory.ppe.view.error',
          service: 'inventory',
          reason,
          correlationId: traceId,
          deptId,
          memberId,
        }),
      );
      emitOutcomeMetric(METRIC_NAMESPACE, 'PpeViewFailed', reason);
      return serviceUnavailableProblem(traceId);
    }
  };
}

export function createHandler(deps?: {
  readonly authzClient?: WithAuthorizationOptions['client'];
  readonly dynamoClient?: DynamoDBDocumentClient;
}): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(createGetPpeHandler(deps?.dynamoClient), {
    actionType: 'Boxalarm::Action',
    actionId: 'ViewPpeAssignments',
    resourceType: 'Boxalarm::Member',
    resourceId: (event) => event.pathParameters?.memberId ?? '',
    ...(deps?.authzClient ? { client: deps.authzClient } : {}),
  });
}

export const handler = createHandler();
