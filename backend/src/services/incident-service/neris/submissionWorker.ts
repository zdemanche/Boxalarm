import type { Context, DynamoDBBatchResponse, Handler, SQSEvent } from 'aws-lambda';
import { createHash, randomUUID } from 'node:crypto';
import {
  ActionAfterCompletion,
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
import { loadSchema } from '../reportContext.js';

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

export const RETRY_SCHEDULE_PREFIX = 'neris-submission-retry-';

/**
 * One schedule per retry attempt, never reused: the name hashes the report, the attempt
 * number and a fresh UUID (63 characters, no truncation), and the schedule deletes itself
 * after it fires. A reused name made a later cycle's CreateSchedule conflict, the conflict
 * was swallowed, no retry ever fired and the report stayed RETRYING (review M3).
 */
export function retryScheduleName(payload: SubmissionWorkerPayload): string {
  const digest = createHash('sha256')
    .update(`${payload.deptId}|${payload.incidentId}|${payload.retryCount}|${randomUUID()}`)
    .digest('hex')
    .slice(0, 40);
  return `${RETRY_SCHEDULE_PREFIX}${digest}`;
}

async function createRetrySchedule(
  scheduler: SchedulerClient,
  functionArn: string,
  payload: SubmissionWorkerPayload,
  delaySeconds: number,
  scheduleName: string,
): Promise<void> {
  const roleArn = readSchedulerRoleArn(process.env);
  const fireAt = Math.floor(Date.now() / 1000) + delaySeconds;
  try {
    await scheduler.send(
      new CreateScheduleCommand({
        Name: scheduleName,
        ScheduleExpression: `at(${new Date(fireAt * 1000).toISOString().slice(0, 19)})`,
        FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
        ActionAfterCompletion: ActionAfterCompletion.DELETE,
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

/**
 * The id NERIS will give this record: `FD########|<incident number>|<call_create epoch s>`
 * (IncidentCreatedResponse.neris_id pattern). Undefined when the payload lacks either part.
 */
export function expectedNerisIncidentId(
  departmentNerisId: string,
  nerisPayload: Record<string, unknown>,
): string | undefined {
  const dispatch = nerisPayload.dispatch as { call_create?: unknown } | undefined;
  const base = nerisPayload.base as { incident_number?: unknown } | undefined;
  const callCreate =
    typeof dispatch?.call_create === 'string' ? Date.parse(dispatch.call_create) : NaN;
  const number = base?.incident_number;
  if (!Number.isFinite(callCreate) || typeof number !== 'string') return undefined;
  return `${departmentNerisId}|${number}|${Math.floor(callCreate / 1000)}`;
}

type SendableIncident = {
  readonly lockedAt?: number | undefined;
  readonly submissionStatus?: string | undefined;
  readonly contentVersion?: number | undefined;
  readonly lockedContentVersion?: number | undefined;
};

/** Why a send must not go out now, or undefined when it may. */
export function sendBlockedReason(
  built: SendableIncident,
  fresh: SendableIncident | undefined,
): string | undefined {
  if (!fresh) return 'MISSING';
  if (fresh.lockedAt === undefined) return 'NOT_LOCKED';
  if (fresh.submissionStatus !== 'SUBMITTED' && fresh.submissionStatus !== 'RETRYING') {
    return 'NOT_IN_FLIGHT';
  }
  const version = fresh.contentVersion ?? 0;
  if (version !== (built.contentVersion ?? 0)) return 'CONTENT_CHANGED';
  if (fresh.lockedContentVersion !== undefined && fresh.lockedContentVersion !== version) {
    return 'CONTENT_CHANGED';
  }
  return undefined;
}

function notifyFor(incident: {
  readonly createdBy: string;
  readonly lockedBy?: string;
  readonly dispatchNumber: string;
}) {
  return {
    ownerId: incident.createdBy,
    ...(incident.lockedBy ? { lockedBy: incident.lockedBy } : {}),
    incidentNumber: incident.dispatchNumber,
  };
}

function looksLikeDuplicate(issues: readonly NerisIssue[]): boolean {
  return issues.some((issue) => /already exists|duplicate/i.test(issue.message));
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

  const incident = await incidentRepository.getIncident(payload.deptId, payload.incidentId, {
    consistent: true,
  });
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
  // Nothing is sent without the NERIS payload schema: every module is deep-picked to it,
  // which is what keeps undeclared (and personal) keys from ever leaving Boxalarm.
  const { nerisApi } = await loadSchema(incident);
  if (!settings.departmentNerisId || !settings.submissionsEnabled || !nerisApi) {
    const failureReason = !settings.departmentNerisId
      ? 'The department NERIS id is not set (platform config NERIS.departmentNerisId)'
      : !settings.submissionsEnabled
        ? 'NERIS submissions are switched off for this department'
        : "The NERIS schema hasn't been downloaded yet (daily schema refresh)";
    // Switched off on purpose (a retry scheduled before the switch was flipped): record it
    // on the ledger, but it is not a failure to page the chief or notify officers about.
    const deliberate = Boolean(settings.departmentNerisId) && !settings.submissionsEnabled;
    await submissionRepository.appendSubmissionAttempt(
      payload.deptId,
      payload.incidentId,
      {
        outcome: 'NOT_CONFIGURED',
        httpStatus: 0,
        retryCount: payload.retryCount,
        nerisEnvironment,
        failureReason,
        ...(deliberate ? {} : { notify: notifyFor(incident) }),
      },
      true,
      Math.floor(Date.now() / 1000),
    );
    emitOutcomeMetric(
      METRIC_NAMESPACE,
      deliberate ? 'SubmissionsDisabled' : OUTCOME_METRIC.NOT_CONFIGURED,
    );
    return;
  }

  // Strongly consistent like the report reads around it (round 2b, R5).
  const units = await queryIncidentResponseUnits(
    client,
    tableName,
    payload.deptId,
    payload.incidentId,
    { consistent: true },
  );
  const nerisPayload = buildNerisIncidentPayload({
    incident,
    units: units as unknown as ResponseUnitRow[],
    departmentNerisId: settings.departmentNerisId,
    unitNerisIds: settings.unitNerisIds,
    schema: nerisApi,
  });
  const hash = payloadHash(nerisPayload);
  // Last check before anything leaves Boxalarm (round 2, N2): re-read the report strongly
  // consistently. It must still be locked, the send must still be the one in flight, and
  // the content must be exactly what was built above and what the officer locked. A
  // redriven DLQ message or a delayed retry for a report since unlocked or edited is
  // dropped without sending.
  const fresh = await incidentRepository.getIncident(payload.deptId, payload.incidentId, {
    consistent: true,
  });
  const reason = sendBlockedReason(incident, fresh);
  if (reason) {
    logger.warn({
      event: 'neris.submission.abandoned',
      correlationId: payload.incidentId,
      deptId: payload.deptId,
      incidentId: payload.incidentId,
      reason,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'SendAbandoned', reason);
    return;
  }

  const expectedNerisId = expectedNerisIncidentId(settings.departmentNerisId, nerisPayload);
  // A record reconciliation gave up on (NERIS stopped listing it) cannot be PUT to — NERIS
  // no longer has that id. Forget it and create the record again (round 2b, R3); the adopt
  // lookup below still finds it if NERIS lists it again after all.
  let knownNerisId = incident.nerisIncidentId;
  const previousNerisId = knownNerisId;
  const recreate =
    knownNerisId !== undefined &&
    fresh?.nerisMissingAt !== undefined &&
    (await submissionRepository.forgetMissingNerisRecord(
      payload.deptId,
      payload.incidentId,
      knownNerisId,
    ));
  if (recreate) {
    logger.info({
      event: 'neris.submission.recreate_missing',
      correlationId: payload.incidentId,
      deptId: payload.deptId,
      incidentId: payload.incidentId,
      previousNerisIncidentId: knownNerisId,
    });
    knownNerisId = undefined;
  }
  let operation: 'CREATE' | 'UPDATE' | 'ADOPT' = knownNerisId ? 'UPDATE' : 'CREATE';

  let httpStatus: number;
  let outcome: SubmissionOutcome;
  let issues: readonly NerisIssue[] = [];
  let nerisIncidentId = knownNerisId;
  let nerisStatus: string | undefined;
  try {
    const config = await readNerisConfig(process.env);
    const api = createNerisApi(getNerisClient(config));
    const entity = settings.departmentNerisId;

    // Idempotent create (review M2). NERIS ids are deterministic
    // (`dept|incident number|call_create`), so a create that may already have landed — a
    // marker from an earlier attempt, or any retry — is first looked up and adopted.
    const adopt = async (): Promise<string | undefined> => {
      // A record being re-created is first looked for under its old id too: if NERIS still
      // (or again) holds it, it is adopted rather than duplicated (round 2c, Q1).
      const candidates = [
        ...new Set([
          recreate ? previousNerisId : undefined,
          incident.pendingNerisId,
          expectedNerisId,
        ]),
      ].filter((id): id is string => typeof id === 'string');
      for (const candidate of candidates) {
        const found = await api.getIncidentStatus(entity, candidate);
        if (found.ok) return candidate;
      }
      return undefined;
    };

    let result;
    if (!nerisIncidentId) {
      const mayExist = recreate || incident.pendingNerisId !== undefined || payload.retryCount > 0;
      const existing = mayExist ? await adopt() : undefined;
      if (existing) {
        nerisIncidentId = existing;
        operation = 'ADOPT';
      } else if (expectedNerisId) {
        await submissionRepository.markCreateInFlight(
          payload.deptId,
          payload.incidentId,
          expectedNerisId,
        );
      }
    }
    if (nerisIncidentId) {
      result = await api.replaceIncident(entity, nerisIncidentId, nerisPayload);
    } else {
      result = await api.createIncident(entity, nerisPayload);
      // NERIS refusing a create as a duplicate means an earlier attempt landed: adopt it.
      // Any 409/422 on a create whose id we can predict: look it up first. NERIS's duplicate
      // response is undocumented (both specs list only 201/422), so the wording is not
      // trusted — a record that exists is adopted, whatever the 422 says (round 2, N1).
      if (
        !result.ok &&
        (result.httpStatus === 409 ||
          (result.httpStatus === 422 && expectedNerisId !== undefined) ||
          looksLikeDuplicate(result.issues))
      ) {
        const existing = await adopt();
        if (existing) {
          nerisIncidentId = existing;
          operation = 'ADOPT';
          result = await api.replaceIncident(entity, existing, nerisPayload);
        }
      }
    }
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

  const scheduleName = canRetry
    ? retryScheduleName({ ...payload, retryCount: payload.retryCount + 1 })
    : undefined;

  const appended = await submissionRepository.appendSubmissionAttempt(
    payload.deptId,
    payload.incidentId,
    {
      outcome,
      ...(scheduleName ? { retryScheduleName: scheduleName } : {}),
      httpStatus,
      retryCount: payload.retryCount,
      nerisEnvironment,
      notify: notifyFor(incident),
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

  if (canRetry && !appended.superseded) {
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
      scheduleName!,
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
