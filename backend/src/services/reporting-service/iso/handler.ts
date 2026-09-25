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
import { createDynamoDocClient, readReportingServiceConfig } from '../awsClients.js';
import { logError } from '../logger.js';
import { readIncidentTableName } from '../responseTimes/handler.js';
import { loadIsoReport } from './repository.js';

const METRICS_NAMESPACE = 'Boxalarm/ReportingService';

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

async function innerGetIsoReport(
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
    const client = createDynamoDocClient();
    const report = await loadIsoReport(
      client,
      client,
      readReportingServiceConfig(process.env).tableName,
      readIncidentTableName(process.env),
      deptId,
      range.from,
      range.to,
    );
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingIsoSucceeded');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    };
  } catch (error) {
    logError('reporting.iso.get_failed', error, { correlationId: traceId, deptId });
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingIsoFailed');
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(innerGetIsoReport, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewIsoReport',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
