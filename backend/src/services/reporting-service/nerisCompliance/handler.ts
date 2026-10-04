import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
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
 * Roster names for the draft owners (member METADATA on the platform table, keyed by the
 * same id as the Cognito sub). A name that cannot be read is simply left out.
 */
async function loadOwnerNames(
  deptId: VerifiedDeptId,
  memberIds: readonly string[],
): Promise<Record<string, string>> {
  const tableName = process.env.PLATFORM_SERVICE_TABLE_NAME;
  if (!tableName) return {};
  const client = createDynamoDocClient();
  const names: Record<string, string> = {};
  await Promise.all(
    [...new Set(memberIds)].map(async (memberId) => {
      try {
        const result = await client.send(
          new GetCommand({
            TableName: tableName,
            Key: { pk: buildDeptScopedPk(deptId, 'MEMBER', memberId), sk: 'METADATA' },
            ProjectionExpression: 'firstName, lastName',
          }),
        );
        const item = result.Item as { firstName?: unknown; lastName?: unknown } | undefined;
        const first = item?.firstName;
        const last = item?.lastName;
        const name = [first, last].filter((part) => typeof part === 'string' && part).join(' ');
        if (name) names[memberId] = name;
      } catch {
        // Names are a courtesy on the tile; the counts do not depend on them.
      }
    }),
  );
  return names;
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
    const draft = computeNerisCompliance(incidents, now, windowDays);
    const ownerNames = await loadOwnerNames(
      deptId,
      draft.openDrafts.flatMap((d) => (d.owner ? [d.owner] : [])),
    );
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingNerisComplianceSucceeded');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(computeNerisCompliance(incidents, now, windowDays, ownerNames)),
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
