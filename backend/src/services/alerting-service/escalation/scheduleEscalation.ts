import {
  ActionAfterCompletion,
  SchedulerClient,
  CreateScheduleCommand,
  FlexibleTimeWindowMode,
  type DeadLetterConfig,
} from '@aws-sdk/client-scheduler';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { createHash } from 'node:crypto';
import AWSXRay from 'aws-xray-sdk-core';
import { logInfo } from '../dispatches/logger.js';

const DEFAULT_ESCALATION_THRESHOLD_SECONDS = 75;

export interface EscalationSchedulerConfig {
  readonly escalationHandlerArn: string;
  readonly schedulerRoleArn: string;
  readonly scheduleGroupName: string;
}

/**
 * The dedicated EventBridge Scheduler group infra provisions for alerting timers
 * (`boxalarm-{env}-alerting-escalation`). Every scheduler:CreateSchedule grant is
 * scoped to `schedule/<this group>/*`, so a schedule created without GroupName lands
 * in the implicit `default` group and is denied.
 */
export function readScheduleGroupName(env: NodeJS.ProcessEnv): string {
  const scheduleGroupName = env.ESCALATION_SCHEDULE_GROUP_NAME;
  if (!scheduleGroupName) {
    throw new Error('ESCALATION_SCHEDULE_GROUP_NAME is required and was not set');
  }
  return scheduleGroupName;
}

/**
 * Post-merge: every alerting timer (voice escalation, tone 2/3 evaluation) is a one-time
 * schedule. Without ActionAfterCompletion they stayed in the group forever after firing (one per
 * member per tone per dispatch, against the account's schedule quota), and without a
 * DeadLetterConfig a target invocation Scheduler finally gave up on vanished with no record - a
 * voice call or tone that never happened. DELETE after completion keeps exactly-once intact: a
 * later re-create of the same name (a retried fan-out) fires into handlers that are idempotent
 * on their own keys (the voice receipt's conditional put, the tone evaluator's TONE_EVENT).
 *
 * The DLQ ARN comes from ESCALATION_SCHEDULE_DLQ_ARN. Until infrastructure sets it the
 * schedule is still created (a missing DLQ must never stop a page) and the gap is logged.
 */
export function alertingScheduleLifecycle(env: NodeJS.ProcessEnv): {
  readonly ActionAfterCompletion: ActionAfterCompletion;
  readonly deadLetterConfig?: DeadLetterConfig;
} {
  const dlqArn = env.ESCALATION_SCHEDULE_DLQ_ARN;
  if (!dlqArn) {
    logInfo('alerting.schedule.dlq_unconfigured', {
      reason: 'ESCALATION_SCHEDULE_DLQ_ARN is not set; schedule created without a DeadLetterConfig',
    });
  }
  return {
    ActionAfterCompletion: ActionAfterCompletion.DELETE,
    ...(dlqArn ? { deadLetterConfig: { Arn: dlqArn } } : {}),
  };
}

export function readEscalationSchedulerConfig(env: NodeJS.ProcessEnv): EscalationSchedulerConfig {
  const escalationHandlerArn = env.ESCALATION_HANDLER_ARN;
  const schedulerRoleArn = env.ESCALATION_SCHEDULER_ROLE_ARN;
  if (!escalationHandlerArn) {
    throw new Error('ESCALATION_HANDLER_ARN is required and was not set');
  }
  if (!schedulerRoleArn) {
    throw new Error('ESCALATION_SCHEDULER_ROLE_ARN is required and was not set');
  }
  return { escalationHandlerArn, schedulerRoleArn, scheduleGroupName: readScheduleGroupName(env) };
}

let cachedSchedulerClient: SchedulerClient | undefined;

export function getSchedulerClient(client?: SchedulerClient): SchedulerClient {
  cachedSchedulerClient ??= client ?? AWSXRay.captureAWSv3Client(new SchedulerClient({}));
  return cachedSchedulerClient;
}

export async function readEscalationThresholdSeconds(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<number> {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'ALERT_RULES'), sk: 'METADATA' },
    }),
  );
  const threshold = (result.Item?.toneLadder as Record<string, unknown> | undefined)
    ?.escalationThresholdSeconds;
  if (typeof threshold !== 'number') {
    logInfo('alerting.escalation.threshold_default', {
      deptId,
      escalationThresholdSeconds: DEFAULT_ESCALATION_THRESHOLD_SECONDS,
    });
    return DEFAULT_ESCALATION_THRESHOLD_SECONDS;
  }
  return threshold;
}

/**
 * EventBridge Scheduler names are at most 64 characters. The old name
 * `esc-{deptId}-{dispatchId}-{memberId}-{tone}`.slice(0, 64) cut the tone off for a real
 * dispatchId + Cognito-sub memberId (85 chars), so tone-2/3 voice schedules collided with the
 * tone-1 schedule, got ConflictException - treated as already scheduled - and were never
 * created: members ignoring tones 2 and 3 were silently never voice-called. The identity is
 * hashed so every {dept, dispatch, member, tone} gets its own name, tone first for reading.
 */
export function escalationScheduleName(
  deptId: string,
  dispatchId: string,
  memberId: string,
  toneSequence: number,
): string {
  const digest = createHash('sha256')
    .update(`${deptId}#${dispatchId}#${memberId}#${toneSequence}`)
    .digest('hex')
    .slice(0, 48);
  return `esc-${toneSequence}-${digest}`;
}

export interface CreateEscalationScheduleInput {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly toneSequence: number;
  readonly delaySeconds?: number;
}

export async function createEscalationSchedule(
  scheduler: SchedulerClient,
  input: CreateEscalationScheduleInput,
  ddb?: DynamoDBDocumentClient,
  tableName?: string,
): Promise<string> {
  const { deptId, dispatchId, memberId, toneSequence } = input;
  const config = readEscalationSchedulerConfig(process.env);
  const delaySeconds =
    input.delaySeconds ??
    (ddb && tableName
      ? await readEscalationThresholdSeconds(ddb, tableName, deptId)
      : DEFAULT_ESCALATION_THRESHOLD_SECONDS);
  const fireAt = Math.floor(Date.now() / 1000) + delaySeconds;
  const scheduleName = escalationScheduleName(deptId, dispatchId, memberId, toneSequence);

  const lifecycle = alertingScheduleLifecycle(process.env);
  try {
    await scheduler.send(
      new CreateScheduleCommand({
        Name: scheduleName,
        GroupName: config.scheduleGroupName,
        ScheduleExpression: `at(${new Date(fireAt * 1000).toISOString().slice(0, 19)})`,
        FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
        ActionAfterCompletion: lifecycle.ActionAfterCompletion,
        Target: {
          Arn: config.escalationHandlerArn,
          RoleArn: config.schedulerRoleArn,
          Input: JSON.stringify({ deptId, dispatchId, memberId, toneSequence, channel: 'voice' }),
          ...(lifecycle.deadLetterConfig ? { DeadLetterConfig: lifecycle.deadLetterConfig } : {}),
        },
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'ConflictException') {
      logInfo('alerting.escalation.schedule_already_exists', {
        deptId,
        dispatchId,
        memberId,
        toneSequence,
        scheduleName,
      });
      return scheduleName;
    }
    throw error;
  }

  return scheduleName;
}
