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
import { readDeliveryBaseline } from './deliveryBaseline.js';
import { getCutoverDecision } from './repository.js';

const METRICS_NAMESPACE = 'Boxalarm/ReportingService';

async function innerGetCutoverDecisionHandler(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const fromRaw = event.queryStringParameters?.from;
  const toRaw = event.queryStringParameters?.to;
  const wantsBaseline = fromRaw !== undefined || toRaw !== undefined;
  const from = Number(fromRaw);
  const to = Number(toRaw);
  if (wantsBaseline && (!Number.isFinite(from) || !Number.isFinite(to) || from > to)) {
    return badRequestProblem(traceId, 'from and to are required epoch seconds with from <= to');
  }
  const deptId = toVerifiedDeptId(principal);
  const config = readReportingServiceConfig(process.env);
  const client = createDynamoDocClient();

  try {
    const record = await getCutoverDecision(client, config.tableName, deptId);
    const retainedPagingRequired = !record || record.decision !== 'accept';
    const deliveryBaseline = wantsBaseline
      ? await readDeliveryBaseline(process.env, event, from, to)
      : undefined;
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingCutoverDecisionGetSucceeded');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: record?.decision ?? null,
        decider: record?.decider ?? null,
        decidedAt: record?.decidedAt ?? null,
        retainedPagingRequired,
        ...(deliveryBaseline ? { deliveryBaseline } : {}),
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
