import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoDocClient } from '../awsClients.js';
import { logError } from '../logger.js';
import { loadResponseTimeAnalytics } from './repository.js';

const METRICS_NAMESPACE = 'Boxalarm/ReportingService';

export function readIncidentTableName(env: NodeJS.ProcessEnv): string {
  const tableName = env.INCIDENT_TABLE_NAME;
  if (!tableName) {
    throw new Error('INCIDENT_TABLE_NAME is required and was not set');
  }
  return tableName;
}

function parseRange(
  qs: Record<string, string | undefined> | null | undefined,
): { from: number; to: number } | undefined {
  const from = Number(qs?.from);
  const to = Number(qs?.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    return undefined;
  }
  return { from, to };
}

async function innerGetResponseTimes(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const range = parseRange(event.queryStringParameters);
  if (!range) {
    return badRequestProblem(traceId, 'from and to are required epoch seconds with from <= to');
  }
  const deptId = toVerifiedDeptId(principal);
  try {
    const analytics = await loadResponseTimeAnalytics(
      createDynamoDocClient(),
      readIncidentTableName(process.env),
      deptId,
      range.from,
      range.to,
    );
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingResponseTimesSucceeded');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: range.from, to: range.to, ...analytics }),
    };
  } catch (error) {
    logError('reporting.responseTimes.get_failed', error, { correlationId: traceId, deptId });
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingResponseTimesFailed');
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(innerGetResponseTimes, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewResponseTimes',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
