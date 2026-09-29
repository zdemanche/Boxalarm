import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoDocClient } from '../awsClients.js';
import { logError } from '../logger.js';
import { queryAllPages } from '../lib/queryAll.js';
import { readIncidentTableName } from '../responseTimes/handler.js';
import {
  computeNerisCompliance,
  toComplianceIncident,
  type ComplianceIncident,
} from './compute.js';

const METRICS_NAMESPACE = 'Boxalarm/ReportingService';
export const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 400;

function parseWindowDays(raw: string | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_WINDOW_DAYS;
  const days = Number(raw);
  return Number.isInteger(days) && days >= 1 && days <= MAX_WINDOW_DAYS ? days : undefined;
}

/**
 * GET /api/v1/reporting/neris-compliance?days=90 — the chief's NERIS tile:
 * {submittedWithin72hPct, rejectionRate, openDrafts: [{id, ageHours, owner, ...}], ...}.
 * Reads incident METADATA through GSI1 (DEPT#{deptId} / INCIDENT#{alarmAt}); no writes.
 */
async function innerGetNerisCompliance(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const windowDays = parseWindowDays(event.queryStringParameters?.days);
  if (windowDays === undefined) {
    return badRequestProblem(traceId, `days must be an integer from 1 to ${MAX_WINDOW_DAYS}`);
  }
  const deptId = toVerifiedDeptId(principal);
  const now = Math.floor(Date.now() / 1000);
  try {
    const items = await queryAllPages(createDynamoDocClient(), {
      TableName: readIncidentTableName(process.env),
      IndexName: 'GSI1',
      KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':pk': buildDeptScopedPk(deptId),
        ':from': `INCIDENT#${now - windowDays * 86_400}`,
        ':to': `INCIDENT#${now}`,
      },
    });
    const incidents = items
      .map(toComplianceIncident)
      .filter((i): i is ComplianceIncident => i !== undefined);
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingNerisComplianceSucceeded');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(computeNerisCompliance(incidents, now, windowDays)),
    };
  } catch (error) {
    logError('reporting.nerisCompliance.get_failed', error, { correlationId: traceId, deptId });
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingNerisComplianceFailed');
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(innerGetNerisCompliance, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewNerisCompliance',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
