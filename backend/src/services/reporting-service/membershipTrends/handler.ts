import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import {
  withAuthorization,
  badRequestProblem,
  serviceUnavailableProblem,
  extractTraceId,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  createDynamoClient,
  readAttendanceTableConfig,
  readPersonnelTableConfig,
  logError,
  logInfo,
} from '../dynamoClient.js';
import { fetchMemberTimelines, fetchAttendanceRecords } from '../lib/memberTimeline.js';
import { computeMembershipTrend } from '../lib/membershipTrend.js';

const METRIC_NAMESPACE = 'Boxalarm/reporting';
const MAX_RANGE_MS = 731 * 24 * 60 * 60 * 1000;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface DateRange {
  readonly startMs: number;
  readonly endMs: number;
}

export function parseDateRange(
  qs: Record<string, string | undefined> | null | undefined,
): DateRange | undefined {
  const startDate = qs?.startDate;
  const endDate = qs?.endDate;
  if (!startDate || !endDate) {
    return undefined;
  }
  const startMs = Date.parse(startDate);
  const rawEndMs = Date.parse(endDate);
  if (Number.isNaN(startMs) || Number.isNaN(rawEndMs)) {
    return undefined;
  }
  if (startMs > rawEndMs) {
    return undefined;
  }
  const endMs = DATE_ONLY_PATTERN.test(endDate) ? rawEndMs + 86_400_000 - 1 : rawEndMs;
  if (endMs - startMs > MAX_RANGE_MS) {
    return undefined;
  }
  return { startMs, endMs };
}

async function getMembershipTrends(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const range = parseDateRange(event.queryStringParameters);
  if (!range) {
    return badRequestProblem(
      traceId,
      'Query parameters startDate and endDate are required ISO date strings with startDate <= endDate and a span of at most 731 days.',
    );
  }

  try {
    const deptId = toVerifiedDeptId(principal);
    const { tableName: personnelTable } = readPersonnelTableConfig(process.env);
    const { tableName: attendanceTable } = readAttendanceTableConfig(process.env);
    const client = createDynamoClient(process.env);

    logInfo('reporting.membership_trends.query_started', traceId, {
      deptId,
      startMs: range.startMs,
      endMs: range.endMs,
    });

    const timelines = await fetchMemberTimelines(client, personnelTable, deptId);
    const attendance = await fetchAttendanceRecords(
      client,
      attendanceTable,
      timelines.map((timeline) => timeline.memberId),
      range.startMs,
      range.endMs,
    );
    const trend = computeMembershipTrend(timelines, attendance, range.startMs, range.endMs);

    logInfo('reporting.membership_trends.query_completed', traceId, {
      memberCount: timelines.length,
      bucketCount: trend.buckets.length,
      attendanceRecordCount: attendance.length,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'MembershipTrendsQueried');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(trend),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    logError('reporting.membership_trends.query_failed', traceId, error, { reason });
    emitOutcomeMetric(METRIC_NAMESPACE, 'MembershipTrendsQueryFailed', reason);
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(getMembershipTrends, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewMembershipTrends',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
