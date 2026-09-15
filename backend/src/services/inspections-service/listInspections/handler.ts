import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  extractTraceId,
  serviceUnavailableProblem,
  badRequestProblem,
  withAuthorization,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { getDocumentClient, readInspectionsConfig } from '../dynamoClient.js';
import {
  ValidationError,
  buildDueGsi2Pk,
  resolveDueWindow,
  toApiInspection,
  type InspectionItem,
} from '../inspectionRecord.js';

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const list = withAuthorization(
  async (event, principal) => {
    const traceId = extractTraceId(event);
    const deptId = toVerifiedDeptId(principal);

    let window;
    try {
      window = resolveDueWindow(event.queryStringParameters, new Date());
    } catch (error) {
      if (error instanceof ValidationError) {
        return badRequestProblem(traceId, error.detail);
      }
      throw error;
    }

    const { tableName } = readInspectionsConfig(process.env);
    const client = getDocumentClient();

    let items: InspectionItem[];
    try {
      const pages = await Promise.all(
        window.months.map((month) =>
          client.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: 'gsi2',
              KeyConditionExpression: 'gsi2pk = :gsi2pkValue AND gsi2sk BETWEEN :lo AND :hi',
              ExpressionAttributeValues: {
                ':gsi2pkValue': buildDueGsi2Pk(deptId, month),
                ':lo': window.startBound,
                ':hi': window.endBound,
              },
            }),
          ),
        ),
      );
      items = pages.flatMap((page) => (page.Items ?? []) as InspectionItem[]);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'inspections.list.queryFailed',
          service: 'inspections-service',
          reason: error instanceof Error ? error.constructor.name : 'UnknownError',
          message: error instanceof Error ? error.message : String(error),
          correlationId: traceId,
          deptId,
        }),
      );
      return serviceUnavailableProblem(traceId);
    }

    items.sort((a, b) => a.gsi2sk.localeCompare(b.gsi2sk));
    return jsonResponse(200, { items: items.map(toApiInspection) });
  },
  {
    actionType: 'Boxalarm::Action',
    actionId: 'ListInspections',
    resourceType: 'Boxalarm::InspectionList',
    resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? 'unknown',
  },
);

export const handler = async (event: GuardEvent): Promise<APIGatewayProxyResultV2> => list(event);
