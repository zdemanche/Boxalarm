import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  withAuthorization,
  serviceUnavailableProblem,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoClient, readAttendanceTableConfig } from '../dynamoClient.js';
import { conflictProblem, validationProblem } from './problemDetails.js';
import { emitAttendanceMetric } from './metrics.js';
import { logInfo } from '../lib/logger.js';
import { getLosapPointRules } from '../losap/configRepository.js';
import { computeLosapPoints } from '../losap/rules.js';
import { buildLosapEntryItem } from '../losap/repository.js';

export const ACTIVITY_TYPES = ['CALL', 'DRILL', 'MEETING', 'WORK_DETAIL', 'STANDBY'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

interface AttendanceInput {
  readonly activityType: ActivityType;
  readonly refId: string | null;
  readonly occurredAt: number;
  readonly hours: number;
}

export type AttendanceKeys = Readonly<Record<'pk' | 'sk' | 'gsi1pk' | 'gsi1sk', string>>;

export function buildAttendanceKeys(
  deptId: VerifiedDeptId,
  memberId: string,
  occurredAt: number,
): AttendanceKeys {
  return {
    pk: buildDeptScopedPk(deptId, 'MEMBER', memberId),
    sk: `ATTENDANCE#${occurredAt}`,
    gsi1pk: `MEMBER#${memberId}`,
    gsi1sk: `ATTENDANCE_RECORD#${occurredAt}`,
  };
}

function isActivityType(value: unknown): value is ActivityType {
  return typeof value === 'string' && (ACTIVITY_TYPES as readonly string[]).includes(value);
}

function parseJsonBody(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function validateAttendanceBody(raw: string | undefined): AttendanceInput | undefined {
  const body = parseJsonBody(raw);
  if (!body) {
    return undefined;
  }
  const { activityType, refId, occurredAt, hours } = body;
  if (!isActivityType(activityType)) {
    return undefined;
  }
  if (typeof occurredAt !== 'number' || !Number.isFinite(occurredAt)) {
    return undefined;
  }
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0) {
    return undefined;
  }
  if (refId !== null && refId !== undefined && typeof refId !== 'string') {
    return undefined;
  }
  return {
    activityType,
    refId: typeof refId === 'string' ? refId : null,
    occurredAt,
    hours,
  };
}

export function extractTraceId(event: GuardEvent): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function logAttendanceFailure(reason: string, error: unknown, traceId: string): void {
  console.error(
    JSON.stringify({
      event: 'attendance.write_failed',
      service: 'personnel-service',
      reason,
      correlationId: traceId,
      originalError: error instanceof Error ? error.message : String(error),
    }),
  );
}

async function recordAttendance(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const input = validateAttendanceBody(event.body);
  if (!input) {
    emitAttendanceMetric('Failed', 'ValidationError');
    return validationProblem(
      traceId,
      'The request body must supply activityType (one of CALL/DRILL/MEETING/WORK_DETAIL/STANDBY), a numeric occurredAt, and a non-negative numeric hours.',
    );
  }

  const deptId = toVerifiedDeptId(principal);
  const memberId = principal.sub;
  const keys = buildAttendanceKeys(deptId, memberId, input.occurredAt);
  const year = new Date(input.occurredAt * 1000).getUTCFullYear();

  try {
    const { tableName } = readAttendanceTableConfig(process.env);
    const client = createDynamoClient(process.env);
    const rules = await getLosapPointRules(client, tableName, deptId);
    if (!rules) {
      logInfo('losap.accrual.skipped', traceId, { reason: 'NoRuleConfig', deptId, memberId });
      emitOutcomeMetric('Boxalarm/Personnel', 'LosapAccrualSkipped', 'NoRuleConfig');
    }
    const losapPointsAwarded = rules
      ? computeLosapPoints(input.activityType, rules.pointsByActivityType)
      : 0;

    const item = {
      ...keys,
      entityType: 'ATTENDANCE_RECORD',
      activityType: input.activityType,
      refId: input.refId,
      occurredAt: input.occurredAt,
      hours: input.hours,
      losapPointsAwarded,
    };

    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: item,
              ConditionExpression: 'attribute_not_exists(sk)',
            },
          },
          ...(rules
            ? [
                {
                  Put: {
                    TableName: tableName,
                    Item: buildLosapEntryItem({
                      deptId,
                      memberId,
                      year,
                      activityType: input.activityType,
                      points: losapPointsAwarded,
                      sourceRefId: keys.sk,
                      ruleVersionId: rules.ruleVersionId,
                      entryId: randomUUID(),
                    }),
                    ConditionExpression: 'attribute_not_exists(sk)',
                  },
                },
              ]
            : []),
        ],
      }),
    );

    emitAttendanceMetric('Recorded');
    return {
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        activityType: item.activityType,
        refId: item.refId,
        occurredAt: item.occurredAt,
        hours: item.hours,
        losapPointsAwarded: item.losapPointsAwarded,
      }),
    };
  } catch (error) {
    const cancellationReasons =
      error instanceof TransactionCanceledException
        ? (error.CancellationReasons ?? []).map((reason) => reason.Code)
        : undefined;
    if (cancellationReasons?.includes('ConditionalCheckFailed')) {
      logAttendanceFailure('DuplicateAttendanceSubmission', error, traceId);
      emitAttendanceMetric('Failed', 'DuplicateAttendanceSubmission');
      return conflictProblem(
        traceId,
        'An attendance record already exists for this member at this occurredAt.',
      );
    }
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    logAttendanceFailure(reason, error, traceId);
    emitAttendanceMetric('Failed', reason);
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(recordAttendance, {
  actionType: 'Boxalarm::Action',
  actionId: 'RecordAttendance',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.sub ?? '',
});
