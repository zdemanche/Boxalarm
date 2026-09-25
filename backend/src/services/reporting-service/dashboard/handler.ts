import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
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
import { loadDashboard } from './repository.js';

const METRICS_NAMESPACE = 'Boxalarm/ReportingService';

async function innerGetDashboard(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const deptId = toVerifiedDeptId(principal);
  try {
    const { tableName } = readReportingServiceConfig(process.env);
    const dashboard = await loadDashboard(createDynamoDocClient(), tableName, deptId, Date.now());
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingDashboardSucceeded');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(dashboard),
    };
  } catch (error) {
    logError('reporting.dashboard.get_failed', error, { correlationId: traceId, deptId });
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingDashboardFailed');
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(innerGetDashboard, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewOperationalDashboard',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
