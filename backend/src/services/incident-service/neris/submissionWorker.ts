import type { Context, DynamoDBBatchResponse, Handler, SQSEvent } from 'aws-lambda';
import {
  CreateScheduleCommand,
  FlexibleTimeWindowMode,
  SchedulerClient,
} from '@aws-sdk/client-scheduler';
import AWSXRay from 'aws-xray-sdk-core';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { createLogger } from '@boxalarm/logging';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { getNerisClient, isBoxalarmProductionEnvironment, readNerisConfig } from './index.js';
import { getIncidentRepository } from '../repository.js';
import { getSubmissionRepository, type SubmissionOutcome } from '../submissionRepository.js';

const METRIC_NAMESPACE = 'Boxalarm/incident-service';
export const MAX_SUBMISSION_RETRIES = 5;
const BASE_BACKOFF_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 900;

const logger = createLogger({ service: 'incident-service' });

export interface SubmissionWorkerPayload {
  readonly deptId: VerifiedDeptId;
  readonly incidentId: string;
  readonly retryCount: number;
}

export function parseSubmissionEnvelope(body: string): SubmissionWorkerPayload {
  const parsed = JSON.parse(body) as { detail?: unknown };
  const detail = parsed.detail as { payload?: Record<string, unknown> } | undefined;
  const payload = detail?.payload;
  if (!payload || typeof payload.deptId !== 'string' || typeof payload.incidentId !== 'string') {
    throw new Error('neris.incident.submitted payload failed shape validation');
  }
  return {
    deptId: toVerifiedDeptId({ deptId: payload.deptId }),
    incidentId: payload.incidentId,
    retryCount: 0,
  };
}

function parseSchedulerPayload(event: unknown): SubmissionWorkerPayload {
  if (typeof event !== 'object' || event === null) {
    throw new Error('submission-worker scheduler invocation payload must be an object');
  }
  const record = event as Record<string, unknown>;
  if (
    typeof record.deptId !== 'string' ||
    typeof record.incidentId !== 'string' ||
    typeof record.retryCount !== 'number'
  ) {
    throw new Error('submission-worker scheduler invocation payload failed shape validation');
  }
  return {
    deptId: toVerifiedDeptId({ deptId: record.deptId }),
    incidentId: record.incidentId,
    retryCount: record.retryCount,
  };
}

let cachedSchedulerClient: SchedulerClient | undefined;

function getSchedulerClient(client?: SchedulerClient): SchedulerClient {
  cachedSchedulerClient ??= client ?? AWSXRay.captureAWSv3Client(new SchedulerClient({}));
  return cachedSchedulerClient;
}

function readSchedulerRoleArn(env: NodeJS.ProcessEnv): string {
  const roleArn = env.NERIS_SUBMISSION_SCHEDULER_ROLE_ARN;
  if (!roleArn) {
    throw new Error('NERIS_SUBMISSION_SCHEDULER_ROLE_ARN is required and was not set');
  }
  return roleArn;
}

async function createRetrySchedule(
  scheduler: SchedulerClient,
  functionArn: string,
  payload: SubmissionWorkerPayload,
  delaySeconds: number,
): Promise<void> {
  const roleArn = readSchedulerRoleArn(process.env);
  const fireAt = Math.floor(Date.now() / 1000) + delaySeconds;
  const scheduleName =
    `neris-submission-retry-${payload.deptId}-${payload.incidentId}-${payload.retryCount}`.slice(
      0,
      64,
    );
  try {
    await scheduler.send(
      new CreateScheduleCommand({
        Name: scheduleName,
        ScheduleExpression: `at(${new Date(fireAt * 1000).toISOString().slice(0, 19)})`,
        FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
        Target: {
          Arn: functionArn,
          RoleArn: roleArn,
          Input: JSON.stringify(payload),
        },
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'ConflictException') {
      return;
    }
    throw error;
  }
}

export function classifyOutcome(httpStatus: number): SubmissionOutcome {
  if (httpStatus >= 200 && httpStatus < 300) {
    return 'SUCCESS';
  }
  if (httpStatus === 429) {
    return 'RATE_LIMITED';
  }
  if (httpStatus >= 400 && httpStatus < 500) {
    return 'VALIDATION_ERROR';
  }
  // 5xx, and any status outside the expected range — fail safe toward a retryable outcome
  // rather than silently dropping the submission.
  return 'SERVER_ERROR';
}

interface AttemptSubmissionDeps {
  readonly schedulerClient?: SchedulerClient;
  readonly functionArn: string;
}

function buildAttemptDeps(
  deps: { schedulerClient?: SchedulerClient },
  functionArn: string,
): AttemptSubmissionDeps {
  return {
    ...(deps.schedulerClient !== undefined ? { schedulerClient: deps.schedulerClient } : {}),
    functionArn,
  };
}

async function attemptSubmission(
  payload: SubmissionWorkerPayload,
  deps: AttemptSubmissionDeps,
): Promise<void> {
  const incidentRepository = getIncidentRepository(process.env);
  const submissionRepository = getSubmissionRepository(process.env);

  const incident = await incidentRepository.getIncident(payload.deptId, payload.incidentId);
  if (!incident) {
    logger.error({
      event: 'neris.submission.incident_missing',
      correlationId: payload.incidentId,
      deptId: payload.deptId,
      incidentId: payload.incidentId,
    });
    return;
  }

  let httpStatus: number;
  let outcome: SubmissionOutcome;
  try {
    const config = await readNerisConfig(process.env);
    const client = getNerisClient(config);
    const response = await client.fetch('/incidents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(incident.corePayload),
    });
    httpStatus = response.status;
    outcome = classifyOutcome(httpStatus);
  } catch (error) {
    logger.error({
      event: 'neris.submission.request_failed',
      correlationId: payload.incidentId,
      deptId: payload.deptId,
      incidentId: payload.incidentId,
      retryCount: payload.retryCount,
      message: error instanceof Error ? error.message : undefined,
    });
    httpStatus = 0;
    outcome = 'SERVER_ERROR';
  }

  const nerisEnvironment = isBoxalarmProductionEnvironment(process.env) ? 'PROD' : 'DEV';
  const retryable = outcome === 'RATE_LIMITED' || outcome === 'SERVER_ERROR';
  const canRetry = retryable && payload.retryCount < MAX_SUBMISSION_RETRIES;
  const terminal = !canRetry;
  const failureReason =
    outcome === 'SUCCESS'
      ? undefined
      : outcome === 'VALIDATION_ERROR'
        ? `NERIS rejected the submission with HTTP ${httpStatus}`
        : canRetry
          ? undefined
          : `NERIS submission failed after ${payload.retryCount} retries (last outcome ${outcome}, HTTP ${httpStatus})`;

  await submissionRepository.appendSubmissionAttempt(
    payload.deptId,
    payload.incidentId,
    {
      outcome,
      httpStatus,
      retryCount: payload.retryCount,
      nerisEnvironment,
      ...(failureReason !== undefined ? { failureReason } : {}),
    },
    terminal,
    Math.floor(Date.now() / 1000),
  );

  emitOutcomeMetric(
    METRIC_NAMESPACE,
    outcome === 'SUCCESS'
      ? 'Submitted'
      : outcome === 'RATE_LIMITED'
        ? 'RateLimited'
        : outcome === 'VALIDATION_ERROR'
          ? 'ValidationRejected'
          : 'ServerError',
  );

  if (canRetry) {
    const delaySeconds = Math.min(
      BASE_BACKOFF_SECONDS * 2 ** payload.retryCount,
      MAX_BACKOFF_SECONDS,
    );
    const scheduler = getSchedulerClient(deps.schedulerClient);
    await createRetrySchedule(
      scheduler,
      deps.functionArn,
      { ...payload, retryCount: payload.retryCount + 1 },
      delaySeconds,
    );
  }
}

export function createHandler(
  deps: { schedulerClient?: SchedulerClient } = {},
): Handler<SQSEvent | Record<string, unknown>, DynamoDBBatchResponse | void> {
  return async (event, context: Context) => {
    if (event && typeof event === 'object' && 'Records' in event) {
      const sqsEvent = event as SQSEvent;
      const batchItemFailures: { itemIdentifier: string }[] = [];
      for (const record of sqsEvent.Records) {
        let payload: SubmissionWorkerPayload;
        try {
          payload = parseSubmissionEnvelope(record.body);
        } catch (error) {
          logger.error({
            event: 'neris.submission.malformed_record',
            correlationId: record.messageId,
            message: error instanceof Error ? error.message : undefined,
          });
          batchItemFailures.push({ itemIdentifier: record.messageId });
          continue;
        }
        try {
          await attemptSubmission(payload, buildAttemptDeps(deps, context.invokedFunctionArn));
        } catch (error) {
          logger.error({
            event: 'neris.submission.attempt_failed',
            correlationId: payload.incidentId,
            deptId: payload.deptId,
            incidentId: payload.incidentId,
            message: error instanceof Error ? error.message : undefined,
          });
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      }
      return { batchItemFailures };
    }

    let payload: SubmissionWorkerPayload;
    try {
      payload = parseSchedulerPayload(event);
    } catch (error) {
      logger.error({
        event: 'neris.submission.malformed_scheduler_payload',
        correlationId: 'unknown',
        message: error instanceof Error ? error.message : undefined,
      });
      return;
    }

    try {
      await attemptSubmission(payload, buildAttemptDeps(deps, context.invokedFunctionArn));
    } catch (error) {
      logger.error({
        event: 'neris.submission.scheduler_attempt_failed',
        correlationId: payload.incidentId,
        deptId: payload.deptId,
        incidentId: payload.incidentId,
        message: error instanceof Error ? error.message : undefined,
      });
      throw error;
    }
  };
}

export const handler = createHandler();
