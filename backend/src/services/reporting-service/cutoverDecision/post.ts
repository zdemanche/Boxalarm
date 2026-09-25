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
import { recordCutoverDecision, type CutoverDecisionStatus } from './repository.js';

const METRICS_NAMESPACE = 'Boxalarm/ReportingService';
const VALID_DECISIONS: readonly CutoverDecisionStatus[] = ['accept', 'defer'];

function parseDecision(body: string | undefined | null): CutoverDecisionStatus | undefined {
  if (!body) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const decision = (parsed as Record<string, unknown>).decision;
  if (typeof decision !== 'string') {
    return undefined;
  }
  return (VALID_DECISIONS as readonly string[]).includes(decision)
    ? (decision as CutoverDecisionStatus)
    : undefined;
}

async function innerPostCutoverDecisionHandler(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const decision = parseDecision(event.body);
  if (!decision) {
    return badRequestProblem(traceId, "decision is required and must be 'accept' or 'defer'");
  }

  const deptId = toVerifiedDeptId(principal);
  const config = readReportingServiceConfig(process.env);
  const client = createDynamoDocClient();
  const record = {
    decision,
    decider: principal.sub,
    decidedAt: Date.now(),
  };

  try {
    await recordCutoverDecision(client, config.tableName, deptId, record);
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingCutoverDecisionPostSucceeded');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    logError('reporting.cutoverDecision.post_failed', error, {
      correlationId: traceId,
      deptId,
      decision,
    });
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingCutoverDecisionPostFailed', reason);
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(innerPostCutoverDecisionHandler, {
  actionType: 'Boxalarm::Action',
  actionId: 'RecordCutoverDecision',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
