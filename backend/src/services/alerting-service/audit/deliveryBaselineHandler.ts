import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import {
  withAuthorization,
  badRequestProblem,
  serviceUnavailableProblem,
  extractTraceId,
  type CedarPrincipalContext,
  type FieldError,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { queryDepartmentAuditLog, type DispatchAuditEntry } from './queryAuditLog.js';
import { computeDeliveryBaseline } from './deliveryBaseline.js';

const METRIC_NAMESPACE = 'Boxalarm/AlertingAudit';
const MAX_PAGES = 200;
const MAX_RANGE_SECONDS = 90 * 24 * 60 * 60;

function parseRange(
  qs: Record<string, string | undefined> | null | undefined,
): { from: number; to: number } | undefined {
  const params = qs ?? {};
  const from = Number(params.from);
  const to = Number(params.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    return undefined;
  }
  return { from, to };
}

async function queryDeliveryBaseline(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const range = parseRange(event.queryStringParameters);
  if (!range) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'DeliveryBaselineQueryFailed', 'InvalidQueryParams');
    return badRequestProblem(traceId, 'Provide both from and to (epoch seconds, from <= to).');
  }
  if (range.to - range.from > MAX_RANGE_SECONDS) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'DeliveryBaselineQueryFailed', 'RangeTooWide');
    const errors: FieldError[] = [
      { field: 'to', detail: 'The from/to date range must not exceed 90 days.' },
    ];
    return badRequestProblem(traceId, errors);
  }

  try {
    const { tableName } = readAlertingConfig(process.env);
    const client = createDynamoClient(process.env);
    const deptId = toVerifiedDeptId(principal);

    const entries: DispatchAuditEntry[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await queryDepartmentAuditLog(
        client,
        tableName,
        deptId,
        range.from,
        range.to,
        cursor,
      );
      entries.push(...result.entries);
      if (!result.nextCursor) {
        break;
      }
      cursor = result.nextCursor;
    }

    const baseline = computeDeliveryBaseline(entries);
    emitOutcomeMetric(METRIC_NAMESPACE, 'DeliveryBaselineQueryServed');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ periodFrom: range.from, periodTo: range.to, ...baseline }),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    console.error(
      JSON.stringify({
        event: 'alerting.deliveryBaseline.query_failed',
        service: 'alerting-service',
        reason,
        correlationId: traceId,
      }),
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'DeliveryBaselineQueryFailed', 'DynamoUnavailable');
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(queryDeliveryBaseline, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewDeliveryBaseline',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
