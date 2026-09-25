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
import { getCutoverDecision } from './repository.js';

const METRICS_NAMESPACE = 'Boxalarm/ReportingService';

async function innerGetCutoverDecisionHandler(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const deptId = toVerifiedDeptId(principal);
  const config = readReportingServiceConfig(process.env);
  const client = createDynamoDocClient();

  try {
    const record = await getCutoverDecision(client, config.tableName, deptId);
    const retainedPagingRequired = !record || record.decision !== 'accept';
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingCutoverDecisionGetSucceeded');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: record?.decision ?? null,
        decider: record?.decider ?? null,
        decidedAt: record?.decidedAt ?? null,
        retainedPagingRequired,
      }),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    logError('reporting.cutoverDecision.get_failed', error, { correlationId: traceId, deptId });
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingCutoverDecisionGetFailed', reason);
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(innerGetCutoverDecisionHandler, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewCutoverDecision',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
