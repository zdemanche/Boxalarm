import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoDocClient, readReportingServiceConfig } from '../awsClients.js';
import { buildYearEndReport } from './repository.js';

const METRICS_NAMESPACE = 'Boxalarm/ReportingService';

export function extractTraceId(event: GuardEvent): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function parseYear(raw: string | undefined): number | undefined {
  if (!raw || !/^\d{4}$/.test(raw)) {
    return undefined;
  }
  return Number.parseInt(raw, 10);
}

async function innerGetLosapYearEndHandler(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const year = parseYear(event.queryStringParameters?.year);
  if (year === undefined) {
    return badRequestProblem(
      traceId,
      'year query parameter is required and must be a 4-digit year',
    );
  }

  const deptId = toVerifiedDeptId(principal);
  const config = readReportingServiceConfig(process.env);
  const client = createDynamoDocClient();

  try {
    const report = await buildYearEndReport(client, config.tableName, deptId, year);
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingLosapYearEndSucceeded');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    console.error(
      JSON.stringify({
        event: 'reporting.losap.year_end.failed',
        service: 'reporting-service',
        correlationId: traceId,
        deptId,
        year,
        reason,
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingLosapYearEndFailed', reason);
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(innerGetLosapYearEndHandler, {
  actionType: 'ReportingService',
  actionId: 'GetLosapYearEnd',
  resourceType: 'Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
