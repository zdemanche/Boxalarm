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
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import {
  InvalidCursorError,
  queryDepartmentAuditLog,
  queryMemberDeliveryHistory,
} from './queryAuditLog.js';

const METRIC_NAMESPACE = 'Boxalarm/AlertingAudit';

function logQueryFailure(
  reason: string,
  error: unknown,
  traceId: string,
  extra: Record<string, unknown> = {},
): void {
  console.error(
    JSON.stringify({
      event: 'alerting.audit.query_failed',
      service: 'alerting-service',
      reason,
      message: error instanceof Error ? error.message : undefined,
      correlationId: traceId,
      ...extra,
    }),
  );
}

function isValidKeySegment(value: string): boolean {
  return value.length > 0 && !value.includes(',') && !value.includes('#');
}

interface MemberQuery {
  readonly memberId: string;
  readonly cursor: string | undefined;
}

interface DateRangeQuery {
  readonly from: number;
  readonly to: number;
  readonly cursor: string | undefined;
}

function parseQuery(
  qs: Record<string, string | undefined> | null | undefined,
): MemberQuery | DateRangeQuery | undefined {
  const params = qs ?? {};
  const cursor = params.cursor;
  const memberId = params.memberId;

  if (memberId !== undefined) {
    return isValidKeySegment(memberId) ? { memberId, cursor } : undefined;
  }

  const fromRaw = params.from;
  const toRaw = params.to;
  if (!fromRaw || !toRaw) {
    return undefined;
  }
  const from = Number(fromRaw);
  const to = Number(toRaw);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    return undefined;
  }
  return { from, to, cursor };
}

async function queryAuditLog(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const parsed = parseQuery(event.queryStringParameters);
  if (!parsed) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'AuditQueryFailed', 'InvalidQueryParams');
    return badRequestProblem(
      traceId,
      'Provide either memberId, or both from and to (epoch seconds, from <= to).',
    );
  }

  try {
    const { tableName } = readAlertingConfig(process.env);
    const client = createDynamoClient(process.env);

    if ('memberId' in parsed) {
      const page = await queryMemberDeliveryHistory(
        client,
        tableName,
        parsed.memberId,
        parsed.cursor,
      );
      emitOutcomeMetric(METRIC_NAMESPACE, 'AuditQueryServed');
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entries: page.entries,
          ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        }),
      };
    }

    const deptId = toVerifiedDeptId(principal);
    const page = await queryDepartmentAuditLog(
      client,
      tableName,
      deptId,
      parsed.from,
      parsed.to,
      parsed.cursor,
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'AuditQueryServed');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entries: page.entries,
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      }),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    logQueryFailure(reason, error, traceId, {
      memberId: 'memberId' in parsed ? parsed.memberId : undefined,
    });

    if (error instanceof InvalidCursorError) {
      emitOutcomeMetric(METRIC_NAMESPACE, 'AuditQueryFailed', 'InvalidCursor');
      return badRequestProblem(traceId, 'cursor is not a valid audit log pagination token.');
    }
    emitOutcomeMetric(METRIC_NAMESPACE, 'AuditQueryFailed', 'DynamoUnavailable');
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(queryAuditLog, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewAlertingAuditLog',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
