import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { withAuthorization, type CedarPrincipalContext, type GuardEvent } from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { AuditConfigError, getDocumentClient, logger, readAuditConfig } from './dynamoClient.js';
import { InvalidCursorError, queryAuditTrailForEntity } from './queryAuditTrail.js';

type AuditEvent = GuardEvent;

interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly traceId: string;
}

function extractTraceId(event: AuditEvent): string {
  const header = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = header?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function problemResponse(
  status: number,
  title: string,
  detail: string,
  traceId: string,
): APIGatewayProxyResultV2 {
  const body: ProblemDetails = {
    type: `https://boxalarm.dev/problems/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    detail,
    traceId,
  };
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify(body),
  };
}

// Metric emission stays on raw console.log(JSON.stringify(...)) rather than the structured
// logger: CloudWatch Embedded Metric Format requires the `_aws` key at the top level of the
// stdout line, which a leveled logger would wrap with its own envelope and break EMF parsing.
function emitAuditQueryMetric(
  name: 'AuditQueryServed' | 'AuditQueryFailed',
  reason?: string,
): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/platform-service',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: name, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [name]: 1,
    }),
  );
}

function isValidKeySegment(value: string): boolean {
  return value.length > 0 && !value.includes(',') && !value.includes('#');
}

async function queryAuditTrail(
  event: AuditEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);

  const params = event.queryStringParameters ?? {};
  const entityType = params.entityType;
  const entityId = params.entityId;
  const cursor = params.cursor;

  if (!entityType || !entityId || !isValidKeySegment(entityType) || !isValidKeySegment(entityId)) {
    emitAuditQueryMetric('AuditQueryFailed', 'InvalidQueryParams');
    return problemResponse(
      400,
      'Bad Request',
      'entityType and entityId query parameters are required and must not contain "," or "#".',
      traceId,
    );
  }

  try {
    const deptId = toVerifiedDeptId(principal);
    const { tableName } = readAuditConfig(process.env);
    const client = getDocumentClient();
    const page = await queryAuditTrailForEntity(
      client,
      tableName,
      deptId,
      entityType,
      entityId,
      cursor,
    );
    emitAuditQueryMetric('AuditQueryServed');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entries: page.entries.map((entry) => ({
          actorId: entry.actorId,
          ts: entry.ts,
          action: entry.action,
          mutatedEntityType: entry.mutatedEntityType,
          mutatedEntityId: entry.mutatedEntityId,
          changedFields: entry.changedFields,
        })),
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      }),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    logger.error({
      event: 'audit.query.failed',
      reason,
      message: error instanceof Error ? error.message : undefined,
      entityType,
      entityId,
      traceId,
    });

    if (error instanceof InvalidCursorError) {
      emitAuditQueryMetric('AuditQueryFailed', 'InvalidCursor');
      return problemResponse(
        400,
        'Bad Request',
        'cursor is not a valid pagination token.',
        traceId,
      );
    }
    if (error instanceof AuditConfigError) {
      emitAuditQueryMetric('AuditQueryFailed', 'ConfigurationError');
      return problemResponse(
        500,
        'Internal Server Error',
        'The audit service is misconfigured.',
        traceId,
      );
    }
    emitAuditQueryMetric('AuditQueryFailed', 'DynamoUnavailable');
    return problemResponse(
      503,
      'Service Unavailable',
      'The audit trail is temporarily unavailable.',
      traceId,
    );
  }
}

/**
 * Security-web MINOR 12: the department's audit trail is Cedar ViewAuditTrail (CHIEF/ADMIN,
 * ADMIN_ONLY_ACTIONS) - the roles the web shows /audit-log to - instead of a hand-rolled groups
 * check that also admitted OFFICER.
 */
export const handler = withAuthorization(queryAuditTrail, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewAuditTrail',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
