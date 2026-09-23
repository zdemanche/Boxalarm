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
import { invalidPpeRequestProblem, ppeAssignmentConflictProblem } from '../problemDetails.js';
import {
  PpeAssignmentConflictError,
  createInventoryDynamoClient,
  issuePpeAssignment,
  readInventoryConfig,
} from '../repository.js';

const METRIC_NAMESPACE = 'Boxalarm/Ppe';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface IssuePpeRequestBody {
  readonly itemType: string;
  readonly size: string;
  readonly issueDate: string;
}

function parseIssueRequest(
  body: string | null | undefined,
  now: Date,
): IssuePpeRequestBody | string {
  if (!body) {
    return 'Request body is required';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 'Request body must be valid JSON';
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return 'Request body must be a JSON object';
  }
  const { itemType, size, issueDate } = parsed as Record<string, unknown>;
  if (typeof itemType !== 'string' || !itemType.trim()) {
    return 'itemType is required and must be a non-empty string';
  }
  if (typeof size !== 'string' || !size.trim()) {
    return 'size is required and must be a non-empty string';
  }
  if (typeof issueDate !== 'string' || !ISO_DATE.test(issueDate)) {
    return 'issueDate is required and must be an ISO date (YYYY-MM-DD)';
  }
  if (issueDate > now.toISOString().slice(0, 10)) {
    return 'issueDate must not be in the future';
  }
  return { itemType: itemType.trim(), size: size.trim(), issueDate };
}

export function createIssuePpeHandler(dynamoClient?: DynamoDBDocumentClient) {
  return async function innerHandler(
    event: GuardEvent,
    principal: CedarPrincipalContext,
  ): Promise<APIGatewayProxyResultV2> {
    const traceId = extractTraceId(event);
    const memberId = event.pathParameters?.memberId;
    if (!memberId) {
      emitOutcomeMetric(METRIC_NAMESPACE, 'PpeIssueFailed', 'MissingMemberId');
      return invalidPpeRequestProblem(traceId, 'pathParameters.memberId is required');
    }
    if (memberId.includes('#')) {
      emitOutcomeMetric(METRIC_NAMESPACE, 'PpeIssueFailed', 'InvalidMemberId');
      return invalidPpeRequestProblem(traceId, 'pathParameters.memberId must not contain "#"');
    }

    const now = new Date();
    const parsed = parseIssueRequest(event.body, now);
    if (typeof parsed === 'string') {
      emitOutcomeMetric(METRIC_NAMESPACE, 'PpeIssueFailed', 'InvalidRequestBody');
      return invalidPpeRequestProblem(traceId, parsed);
    }

    const deptId = toVerifiedDeptId(principal);

    try {
      const client = createInventoryDynamoClient(process.env, dynamoClient);
      const config = readInventoryConfig(process.env);

      const assignment = await issuePpeAssignment(client, config, {
        deptId,
        memberId,
        actorId: principal.sub,
        correlationId: traceId,
        itemType: parsed.itemType,
        size: parsed.size,
        issueDate: parsed.issueDate,
        now,
      });

      emitOutcomeMetric(METRIC_NAMESPACE, 'PpeIssued');
      return {
        statusCode: 201,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(assignment),
      };
    } catch (error) {
      if (error instanceof PpeAssignmentConflictError) {
        console.error(
          JSON.stringify({
            event: 'inventory.ppe.issue.conflict',
            service: 'inventory',
            reason: error.message,
            errorType: error.constructor.name,
            correlationId: traceId,
            deptId,
            memberId,
          }),
        );
        emitOutcomeMetric(METRIC_NAMESPACE, 'PpeIssueFailed', 'AlreadyIssued');
        return ppeAssignmentConflictProblem(traceId, error.message);
      }
      const reason = error instanceof Error ? error.message : String(error);
      const errorType = error instanceof Error ? error.constructor.name : 'UnknownError';
      console.error(
        JSON.stringify({
          event: 'inventory.ppe.issue.error',
          service: 'inventory',
          reason,
          errorType,
          correlationId: traceId,
          deptId,
          memberId,
        }),
      );
      emitOutcomeMetric(METRIC_NAMESPACE, 'PpeIssueFailed', errorType);
      return serviceUnavailableProblem(traceId);
    }
  };
}

export function createHandler(deps?: {
  readonly authzClient?: WithAuthorizationOptions['client'];
  readonly dynamoClient?: DynamoDBDocumentClient;
}): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(createIssuePpeHandler(deps?.dynamoClient), {
    actionType: 'Boxalarm::Action',
    actionId: 'IssuePpeAssignment',
    resourceType: 'Boxalarm::Member',
    resourceId: (event) => event.pathParameters?.memberId ?? '',
    ...(deps?.authzClient ? { client: deps.authzClient } : {}),
  });
}

export const handler = createHandler();
