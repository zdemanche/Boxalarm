import { randomUUID } from 'node:crypto';
import { DeleteScheduleCommand, type SchedulerClient } from '@aws-sdk/client-scheduler';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import {
  badRequestProblem,
  extractTraceId,
  forbiddenProblem,
  notFoundProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { buildAuditLogEntryTransactItem } from '../../platform-service/audit/auditEntry.js';
import { createDdbClient, parseMarkoffItem, readPersonnelDdbConfig } from './dynamoClient.js';
import { availabilityScheduleBaseName, getSchedulerClient } from './handler.js';

/**
 * Mark-offs, listed and ended early (paging review MAJOR-A). Once mark-offs reached alerting
 * (e45e3d9) a mark-off really stops a member's pages - and there was no way back but waiting
 * for endAt. These two routes are the way back, shared by the web and the mobile app:
 *
 *   GET  /api/v1/personnel/members/{memberId}/availability
 *        -> { markOffs: [{ markoffId, startAt, endAt, reason? }] }   current and upcoming,
 *           epoch seconds; markoffId is the stored startAt (rows are MARKOFF#{startAt}).
 *   POST /api/v1/personnel/members/{memberId}/availability/{markoffId}/end
 *        -> { markoffId, endedAt }   ends a current window now; cancels an upcoming one.
 *
 * The MARKOFF#{startAt} row is never deleted (mobile review R3-M2): ending sets endAt = now
 * (an upcoming window: endAt = startAt, cancelled), revertedAt, endedAt and endedBy. So a
 * replayed original create for the same startAt still fails its attribute_not_exists(sk)
 * condition with 409, instead of re-creating the window and unpaging the member again.
 *
 * Who: the member on their own record (ViewOwnAvailability / EndOwnMarkoff, every role), or an
 * OFFICER/CHIEF/ADMIN on anyone's (ViewMemberAvailability / EndMemberMarkoff) - the updateMember
 * two-guard pattern, routed on path memberId === caller sub and re-checked before any read.
 */

const METRIC_NAMESPACE = 'Boxalarm/personnel-availability';
const MARKOFF_ID = /^\d{1,10}$/;
/** Re-reads after a lost race (an ACTIVATE or another end landing between read and write). */
const MAX_END_ATTEMPTS = 3;

export interface MarkoffRouteDeps {
  readonly schedulerClient?: SchedulerClient;
}

interface ListedMarkoff {
  readonly markoffId: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly reason?: string;
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function serviceUnavailable(traceId: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 503,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: 'https://boxalarm.dev/problems/service-unavailable',
      title: 'Service Unavailable',
      status: 503,
      detail: 'Unable to read or change availability at this time.',
      traceId,
    }),
  };
}

function logError(event: string, error: unknown, traceId: string, extra = {}): void {
  console.error(
    JSON.stringify({
      event,
      service: 'personnel-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      correlationId: traceId,
      ...extra,
    }),
  );
}

/** The self-path guard's re-check: the verified principal really is the path member. */
function selfOnly(event: GuardEvent, principal: CedarPrincipalContext): boolean {
  return event.pathParameters?.memberId === principal.sub;
}

export async function listMarkoffs(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = event.pathParameters?.memberId;
  if (!memberId) {
    return badRequestProblem(traceId, 'memberId path parameter is required.');
  }
  const deptId = toVerifiedDeptId(principal);
  const { tableName } = readPersonnelDdbConfig(process.env);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const markOffs: ListedMarkoff[] = [];
  try {
    const ddb = createDdbClient(process.env);
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: {
            ':pk': buildDeptScopedPk(deptId, 'MEMBER', memberId),
            ':prefix': 'MARKOFF#',
          },
          ConsistentRead: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      for (const item of page.Items ?? []) {
        const markoff = parseMarkoffItem(item);
        if (!markoff || markoff.revertedAt !== undefined || markoff.endAt <= nowSeconds) {
          continue;
        }
        markOffs.push({
          markoffId: String(markoff.startAt),
          startAt: markoff.startAt,
          endAt: markoff.endAt,
          ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
        });
      }
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey);
  } catch (error) {
    logError('availability.list_failed', error, traceId, { memberId });
    return serviceUnavailable(traceId);
  }
  markOffs.sort((a, b) => a.startAt - b.startAt);
  return json(200, { markOffs });
}

async function deleteMarkoffSchedules(
  scheduler: SchedulerClient,
  deptId: VerifiedDeptId,
  memberId: string,
  startAt: number,
  traceId: string,
): Promise<void> {
  const base = availabilityScheduleBaseName(deptId, memberId, startAt);
  for (const name of [`${base}-start`, `${base}-end`]) {
    try {
      await scheduler.send(new DeleteScheduleCommand({ Name: name }));
    } catch (error) {
      // Not found: already fired (it deletes itself) or never created (an immediate mark-off
      // has no -start). Anything else is logged: a schedule that later fires finds the row
      // already ended and does nothing (expiryHandler checks revertedAt).
      if (error instanceof Error && error.name === 'ResourceNotFoundException') continue;
      logError('availability.end.schedule_delete_failed', error, traceId, { scheduleName: name });
    }
  }
}

export async function endMarkoff(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: MarkoffRouteDeps,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = event.pathParameters?.memberId;
  const markoffId = event.pathParameters?.markoffId;
  if (!memberId) {
    return badRequestProblem(traceId, 'memberId path parameter is required.');
  }
  if (!markoffId || !MARKOFF_ID.test(markoffId)) {
    return badRequestProblem(traceId, 'markoffId must be the mark-off start time (epoch seconds).');
  }
  const startAt = Number(markoffId);
  const deptId = toVerifiedDeptId(principal);
  const { tableName } = readPersonnelDdbConfig(process.env);
  const ddb = createDdbClient(process.env);
  const pk = buildDeptScopedPk(deptId, 'MEMBER', memberId);
  const sk = `MARKOFF#${startAt}`;

  const readMarkoff = async () => {
    const result = await ddb.send(
      new GetCommand({ TableName: tableName, Key: { pk, sk }, ConsistentRead: true }),
    );
    return parseMarkoffItem(result.Item);
  };

  let markoff;
  try {
    markoff = await readMarkoff();
  } catch (error) {
    logError('availability.end.read_failed', error, traceId, { memberId, markoffId });
    return serviceUnavailable(traceId);
  }
  if (!markoff) {
    return notFoundProblem(traceId, `No mark-off ${markoffId} for member ${memberId}.`);
  }

  /**
   * Paging review MAJOR-R2-1: an ACTIVATE committing between this read and the write below
   * emits MARKED_OFF with a later eventTime than an AVAILABLE stamped before it, so the
   * snapshot would drop AVAILABLE as stale and keep the member marked off. The write is
   * therefore conditioned on the activatedAt state just read; on a conflict the row is re-read
   * and the end retried. The AVAILABLE eventTime is at least a second after activatedAt (whose
   * MARKED_OFF was stamped within that second), so it always sorts after the activation.
   */
  let nowSeconds: number;
  let cancelled: boolean;
  for (let attempt = 1; ; attempt += 1) {
    if (markoff.revertedAt !== undefined) {
      // Already over (ended, or reverted at endAt): nothing to do, and saying so is the truth.
      return json(200, { markoffId, endedAt: markoff.revertedAt, alreadyEnded: true });
    }
    const readActivatedAt = markoff.activatedAt;
    const eventTimeMs = Math.max(
      Date.now(),
      readActivatedAt !== undefined ? (readActivatedAt + 1) * 1000 : 0,
    );
    nowSeconds = Math.floor(Date.now() / 1000);
    const eventId = randomUUID();
    cancelled = readActivatedAt === undefined && startAt > nowSeconds;
    const newEndAt = cancelled ? startAt : Math.min(nowSeconds, markoff.endAt);
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName,
                Key: { pk, sk },
                UpdateExpression:
                  'SET endAt = :endAt, revertedAt = :now, endedAt = :now, endedBy = :actor, cancelled = :cancelled',
                ConditionExpression:
                  readActivatedAt === undefined
                    ? 'attribute_exists(sk) AND attribute_not_exists(revertedAt) AND attribute_not_exists(activatedAt)'
                    : 'attribute_exists(sk) AND attribute_not_exists(revertedAt) AND activatedAt = :readActivatedAt',
                ExpressionAttributeValues: {
                  ':endAt': newEndAt,
                  ':now': nowSeconds,
                  ':actor': principal.sub,
                  ':cancelled': cancelled,
                  ...(readActivatedAt !== undefined ? { ':readActivatedAt': readActivatedAt } : {}),
                },
              },
            },
            {
              // Always AVAILABLE, even for a window not yet activated: AVAILABLE for a member
              // never marked off is a no-op in the snapshot.
              Put: {
                TableName: tableName,
                Item: {
                  pk: buildDeptScopedPk(deptId, 'OUTBOX', 'MEMBER', memberId),
                  sk: `EVT#${eventId}`,
                  entityType: 'OUTBOX_ENTRY',
                  eventId,
                  eventType: 'personnel.availability.changed',
                  correlationId: memberId,
                  eventTime: new Date(eventTimeMs).toISOString(),
                  source: 'personnel-service',
                  schemaVersion: '1.0',
                  createdAt: nowSeconds,
                  payload: { deptId, memberId, availabilityState: 'AVAILABLE', startAt },
                },
              },
            },
            buildAuditLogEntryTransactItem(tableName, {
              deptId,
              actorId: principal.sub,
              mutatedEntityType: 'AVAILABILITY_MARKOFF',
              mutatedEntityId: `${memberId}-${startAt}`,
              action: 'UPDATE',
              before: { endAt: markoff.endAt },
              after: { endAt: newEndAt, endedEarly: true, cancelled },
              ts: eventTimeMs,
              traceId,
            }),
          ],
        }),
      );
      break;
    } catch (error) {
      const reasons =
        error instanceof Error && error.name === 'TransactionCanceledException'
          ? (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons
          : undefined;
      if (reasons?.[0]?.Code === 'ConditionalCheckFailed' && attempt < MAX_END_ATTEMPTS) {
        // Activated or ended since the read: read again and decide on what is there now.
        try {
          markoff = await readMarkoff();
        } catch (readError) {
          logError('availability.end.read_failed', readError, traceId, { memberId, markoffId });
          return serviceUnavailable(traceId);
        }
        if (!markoff) {
          return notFoundProblem(traceId, `No mark-off ${markoffId} for member ${memberId}.`);
        }
        continue;
      }
      logError('availability.end.write_failed', error, traceId, { memberId, markoffId });
      emitOutcomeMetric(METRIC_NAMESPACE, 'MarkoffEndFailed', 'DynamoDbUnavailable');
      return serviceUnavailable(traceId);
    }
  }

  await deleteMarkoffSchedules(
    getSchedulerClient(deps.schedulerClient),
    deptId,
    memberId,
    startAt,
    traceId,
  );
  emitOutcomeMetric(
    METRIC_NAMESPACE,
    'MarkoffEndedEarly',
    selfOnly(event, principal) ? 'Self' : 'Officer',
  );
  console.log(
    JSON.stringify({
      event: 'availability.ended_early',
      service: 'personnel-service',
      correlationId: traceId,
      memberId,
      markoffId,
      actorId: principal.sub,
    }),
  );
  return json(200, { markoffId, endedAt: nowSeconds, cancelled });
}

interface CedarActionLiteral {
  readonly actionType: string;
  readonly actionId: string;
  readonly resourceType: string;
}

/**
 * Routes to the self or the officer Cedar action on path memberId === caller sub. The actions
 * are written as literals at the call sites so infrastructure's cedar-coverage test checks them.
 */
function twoGuard(
  selfAction: CedarActionLiteral,
  officerAction: CedarActionLiteral,
  inner: (event: GuardEvent, principal: CedarPrincipalContext) => Promise<APIGatewayProxyResultV2>,
) {
  const resourceId = (event: GuardEvent) => event.pathParameters?.memberId ?? '';
  const self = withAuthorization(
    (event, principal) =>
      selfOnly(event, principal)
        ? inner(event, principal)
        : Promise.resolve(forbiddenProblem(extractTraceId(event))),
    { ...selfAction, resourceId },
  );
  const officer = withAuthorization(inner, { ...officerAction, resourceId });
  return (event: GuardEvent) => {
    const callerSub = event.requestContext.authorizer?.lambda?.sub;
    return callerSub && event.pathParameters?.memberId === callerSub ? self(event) : officer(event);
  };
}

export function createListHandler() {
  return twoGuard(
    {
      actionType: 'Boxalarm::Action',
      actionId: 'ViewOwnAvailability',
      resourceType: 'Boxalarm::Member',
    },
    {
      actionType: 'Boxalarm::Action',
      actionId: 'ViewMemberAvailability',
      resourceType: 'Boxalarm::Member',
    },
    listMarkoffs,
  );
}

export function createEndHandler(deps: MarkoffRouteDeps = {}) {
  return twoGuard(
    { actionType: 'Boxalarm::Action', actionId: 'EndOwnMarkoff', resourceType: 'Boxalarm::Member' },
    {
      actionType: 'Boxalarm::Action',
      actionId: 'EndMemberMarkoff',
      resourceType: 'Boxalarm::Member',
    },
    (event, principal) => endMarkoff(event, principal, deps),
  );
}

export const listHandler = createListHandler();
export const endHandler = createEndHandler();
