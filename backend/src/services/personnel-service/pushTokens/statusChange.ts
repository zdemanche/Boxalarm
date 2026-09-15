import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  notFoundProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createDynamoClient, readPersonnelConfig } from '../dynamoClient.js';

const MEMBER_STATUSES = ['ACTIVE', 'PROBATIONARY', 'LOA', 'RETIRED'] as const;
type MemberStatus = (typeof MEMBER_STATUSES)[number];

export interface StatusChangeBody {
  readonly status: MemberStatus;
}

export function parseStatusBody(raw: string | undefined | null): StatusChangeBody {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error('body must be valid JSON');
  }
  const status = (parsed as Partial<Record<string, unknown>> | undefined)?.status;
  if (typeof status !== 'string' || !MEMBER_STATUSES.includes(status as MemberStatus)) {
    throw new Error(`status is required and must be one of ${MEMBER_STATUSES.join(', ')}`);
  }
  return { status: status as MemberStatus };
}

function extractTraceId(event: GuardEvent): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function emitMemberStatusMetric(outcome: 'Changed' | 'Failed', reason?: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/PushToken',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: `MemberStatus${outcome}`, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [`MemberStatus${outcome}`]: 1,
    }),
  );
}

async function statusChange(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = event.pathParameters?.memberId;
  if (!memberId) {
    return badRequestProblem(traceId, 'memberId path parameter is required');
  }

  let body: StatusChangeBody;
  try {
    body = parseStatusBody(event.body);
  } catch (error) {
    return badRequestProblem(traceId, error instanceof Error ? error.message : 'invalid body');
  }

  const deptId = toVerifiedDeptId(principal);
  const pk = buildDeptScopedPk(deptId, 'MEMBER', memberId);
  const client = createDynamoClient(process.env);
  const config = readPersonnelConfig(process.env);

  const revokesTokens = body.status !== 'ACTIVE';
  const now = Date.now();
  const eventId = randomUUID();

  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: config.tableName,
              Key: { pk, sk: 'METADATA' },
              ConditionExpression: 'attribute_exists(pk)',
              UpdateExpression: revokesTokens
                ? 'SET #status = :status, contactChannels = :empty, updatedAt = :ts'
                : 'SET #status = :status, updatedAt = :ts',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: revokesTokens
                ? { ':status': body.status, ':empty': [], ':ts': now }
                : { ':status': body.status, ':ts': now },
            },
          },
          {
            Put: {
              TableName: config.tableName,
              Item: {
                pk: buildDeptScopedPk(deptId, 'OUTBOX', memberId),
                sk: `EVT#${eventId}`,
                entityType: 'OUTBOX_ENTRY',
                eventId,
                eventTime: new Date(now).toISOString(),
                eventType: 'personnel.member.updated',
                source: 'personnel-service',
                correlationId: memberId,
                schemaVersion: '1.0',
                payload: {
                  memberId,
                  deptId,
                  status: body.status,
                  active: body.status === 'ACTIVE',
                  ...(revokesTokens ? { contactChannels: [] } : {}),
                },
                sentAt: null,
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    const cancellationReasons =
      error instanceof TransactionCanceledException
        ? (error.CancellationReasons?.map((r) => r.Code) ?? [])
        : undefined;
    console.error(
      JSON.stringify({
        event: 'personnel.member.status.change.failed',
        service: 'personnel-service',
        correlationId: traceId,
        memberId,
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
        cancellationReasons,
      }),
    );
    if (
      error instanceof TransactionCanceledException &&
      cancellationReasons?.includes('ConditionalCheckFailed')
    ) {
      emitMemberStatusMetric('Failed', 'ConditionalCheckFailed');
      return notFoundProblem(traceId, `member ${memberId} was not found`);
    }
    emitMemberStatusMetric('Failed', 'UnknownError');
    throw error;
  }

  console.log(
    JSON.stringify({
      event: 'personnel.member.status.changed',
      service: 'personnel-service',
      correlationId: traceId,
      memberId,
      status: body.status,
    }),
  );
  emitMemberStatusMetric('Changed');

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      memberId,
      status: body.status,
      contactChannels: revokesTokens ? [] : undefined,
    }),
  };
}

export const handler = withAuthorization(statusChange, {
  actionType: 'MEMBER',
  actionId: 'UpdateMemberStatus',
  resourceType: 'MEMBER',
  resourceId: (event) => event.pathParameters?.memberId ?? '',
});
