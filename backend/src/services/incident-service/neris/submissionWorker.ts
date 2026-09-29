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
import { createNerisApi, type NerisIssue } from './api.js';
import { buildNerisIncidentPayload, payloadHash, type ResponseUnitRow } from './payload.js';
import { getDocumentClient, getIncidentRepository, getTableName } from '../repository.js';
import { getSubmissionRepository, type SubmissionOutcome } from '../submissionRepository.js';
import { getNerisDeptSettings } from '../nerisSettings.js';
import { queryIncidentResponseUnits } from '../dispatchProjection.js';

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
  if (httpStatus === 422) {
    return 'VALIDATION_ERROR';
  }
  if (httpStatus >= 400 && httpStatus < 500) {
    return 'CLIENT_ERROR';
  }
  // 5xx, and any status outside the expected range — fail safe toward a retryable outcome
  // rather than silently dropping the submission.
  return 'SERVER_ERROR';
}

const OUTCOME_METRIC: Record<SubmissionOutcome, string> = {
  SUCCESS: 'Submitted',
  RATE_LIMITED: 'RateLimited',
  VALIDATION_ERROR: 'ValidationRejected',
  SERVER_ERROR: 'ServerError',
  CLIENT_ERROR: 'ClientError',
  NOT_CONFIGURED: 'NotConfigured',
};

function describeIssues(issues: readonly NerisIssue[]): string {
  if (issues.length === 0) {
    return '';
  }
  const shown = issues
    .slice(0, 3)
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join('; ');
  return issues.length > 3 ? `: ${shown} (+${issues.length - 3} more)` : `: ${shown}`;
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

  const nerisEnvironment = isBoxalarmProductionEnvironment(process.env) ? 'PROD' : 'DEV';
  const client = getDocumentClient();
  const tableName = getTableName(process.env);
  const settings = await getNerisDeptSettings(client, tableName, payload.deptId);
  if (!settings.departmentNerisId || !settings.submissionsEnabled) {
    const failureReason = !settings.departmentNerisId
      ? 'The department NERIS id is not set (platform config NERIS.departmentNerisId)'
      : 'NERIS submissions are switched off for this department';
    await submissionRepository.appendSubmissionAttempt(
      payload.deptId,
      payload.incidentId,
      {
        outcome: 'NOT_CONFIGURED',
        httpStatus: 0,
        retryCount: payload.retryCount,
        nerisEnvironment,
        failureReason,
      },
      true,
      Math.floor(Date.now() / 1000),
    );
    emitOutcomeMetric(METRIC_NAMESPACE, OUTCOME_METRIC.NOT_CONFIGURED);
    return;
  }

  const units = await queryIncidentResponseUnits(
    client,
    tableName,
    payload.deptId,
    payload.incidentId,
  );
  const nerisPayload = buildNerisIncidentPayload({
    incident,
    units: units as unknown as ResponseUnitRow[],
    departmentNerisId: settings.departmentNerisId,
    unitNerisIds: settings.unitNerisIds,
  });
  const hash = payloadHash(nerisPayload);
  const operation = incident.nerisIncidentId ? 'UPDATE' : 'CREATE';

  let httpStatus: number;
  let outcome: SubmissionOutcome;
  let issues: readonly NerisIssue[] = [];
  let nerisIncidentId = incident.nerisIncidentId;
  let nerisStatus: string | undefined;
  try {
    const config = await readNerisConfig(process.env);
    const api = createNerisApi(getNerisClient(config));
    const result = incident.nerisIncidentId
      ? await api.replaceIncident(
          settings.departmentNerisId,
          incident.nerisIncidentId,
          nerisPayload,
        )
      : await api.createIncident(settings.departmentNerisId, nerisPayload);
    httpStatus = result.httpStatus;
    if (result.ok) {
      outcome = 'SUCCESS';
      if ('nerisId' in result) {
        nerisIncidentId = result.nerisId;
        nerisStatus = result.status;
      }
    } else {
      // A 2xx with no neris_id comes back as a server_error failure: retry it.
      outcome = result.kind === 'server_error' ? 'SERVER_ERROR' : classifyOutcome(httpStatus);
      issues = result.issues;
    }
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

  const retryable = outcome === 'RATE_LIMITED' || outcome === 'SERVER_ERROR';
  const canRetry = retryable && payload.retryCount < MAX_SUBMISSION_RETRIES;
  const terminal = !canRetry;
  const failureReason =
    outcome === 'SUCCESS'
      ? undefined
      : outcome === 'VALIDATION_ERROR'
        ? `NERIS rejected the submission with HTTP ${httpStatus}${describeIssues(issues)}`
        : outcome === 'CLIENT_ERROR'
          ? `NERIS refused the request with HTTP ${httpStatus} (credentials, entity id or record id)`
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
      operation,
      payloadHash: hash,
      ...(nerisIncidentId !== undefined ? { nerisIncidentId } : {}),
      ...(nerisStatus !== undefined ? { nerisStatus } : {}),
      ...(outcome === 'SUCCESS' ? { acceptedPayload: nerisPayload } : {}),
      ...(issues.length > 0 ? { errors: issues } : {}),
      ...(failureReason !== undefined ? { failureReason } : {}),
    },
    terminal,
    Math.floor(Date.now() / 1000),
  );

  emitOutcomeMetric(METRIC_NAMESPACE, OUTCOME_METRIC[outcome]);

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
