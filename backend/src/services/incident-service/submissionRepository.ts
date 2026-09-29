import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';
import { createLogger } from '@boxalarm/logging';
import { IncidentNotFoundError, getDocumentClient, getTableName } from './repository.js';
import type { IncidentStatus } from './entity.js';

const logger = createLogger({ service: 'incident-service' });

export const SUBMISSION_OUTCOMES = [
  'SUCCESS',
  'RATE_LIMITED',
  'VALIDATION_ERROR',
  'SERVER_ERROR',
  /** A 4xx other than 422/429 (auth, WAF, unknown record): not a verdict on the report. */
  'CLIENT_ERROR',
  /** The department has no NERIS id yet, or NERIS submissions are switched off. */
  'NOT_CONFIGURED',
] as const;

export type SubmissionOutcome = (typeof SUBMISSION_OUTCOMES)[number];

export const SUBMISSION_STATUSES = ['SUBMITTED', 'ACCEPTED', 'FAILED', 'RETRYING'] as const;

export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/**
 * Submission statuses meaning the worker may be sending the record right now. Nothing may
 * lock, unlock, submit or resubmit a report while one of these holds (review M1).
 */
export const NOT_IN_FLIGHT_CONDITION =
  '(attribute_not_exists(submissionStatus) OR (submissionStatus <> :queued AND submissionStatus <> :retrying) OR attribute_not_exists(submissionActivityAt) OR submissionActivityAt < :staleBefore)';

/**
 * A send with no activity for this long is not in flight any more, whatever its status
 * says: the retry chain (30 s doubling to a 900 s cap, five retries) ends within about 16
 * minutes, so an hour of silence means a lost trigger. Past it, unlock, lock, resubmit and
 * retry are allowed again, so no report can stay locked forever (review M3).
 */
export const STALE_IN_FLIGHT_MS = 60 * 60 * 1000;

export function inFlightValues(nowMs: number = Date.now()) {
  return {
    ':queued': 'SUBMITTED',
    ':retrying': 'RETRYING',
    ':staleBefore': new Date(nowMs - STALE_IN_FLIGHT_MS).toISOString(),
  } as const;
}

/** The same test as NOT_IN_FLIGHT_CONDITION, on a row already read. */
export function isInFlight(item: Record<string, unknown>, nowMs: number = Date.now()): boolean {
  const status = item.submissionStatus;
  if (status !== 'SUBMITTED' && status !== 'RETRYING') return false;
  const activity = item.submissionActivityAt;
  return typeof activity === 'string' && activity >= inFlightValues(nowMs)[':staleBefore'];
}

export type SubmissionConflictReason = 'NOT_VALIDATED' | 'NOT_LOCKED' | 'IN_FLIGHT' | 'IN_NERIS';

export class SubmissionConflictError extends Error {
  constructor(
    incidentId: string,
    currentStatus: string,
    readonly reason: SubmissionConflictReason = 'NOT_VALIDATED',
  ) {
    super(
      reason === 'NOT_LOCKED'
        ? `incident "${incidentId}" must be locked by an officer before it is submitted to NERIS`
        : reason === 'IN_FLIGHT'
          ? `incident "${incidentId}" already has a NERIS submission in progress`
          : reason === 'IN_NERIS'
            ? `NERIS already holds incident "${incidentId}": send the correction with resubmit, which shows what changed`
            : `incident "${incidentId}" is not VALIDATED and cannot be submitted (current status "${currentStatus}")`,
    );
    this.name = 'SubmissionConflictError';
  }
}

export class SubmissionRetryConflictError extends Error {
  constructor(incidentId: string, currentStatus: string) {
    super(
      `incident "${incidentId}" submission is not FAILED and cannot be retried (current submission status "${currentStatus}")`,
    );
    this.name = 'SubmissionRetryConflictError';
  }
}

function isSubmissionStatus(value: unknown): value is SubmissionStatus {
  return typeof value === 'string' && (SUBMISSION_STATUSES as readonly string[]).includes(value);
}

function toSubmissionRecord(incidentId: string, item: Record<string, unknown>): SubmissionRecord {
  const submissionStatus = isSubmissionStatus(item.submissionStatus)
    ? item.submissionStatus
    : undefined;
  const failureReason = item.submissionFailureReason;
  const ledgerFields = Object.fromEntries(
    LEDGER_FIELDS.flatMap((field) =>
      typeof item[field] === 'string' || typeof item[field] === 'number'
        ? [[field, item[field]]]
        : [],
    ),
  );
  return {
    incidentId,
    status: typeof item.status === 'string' ? item.status : '',
    ...(submissionStatus !== undefined ? { submissionStatus } : {}),
    ...(submissionStatus === 'FAILED' && typeof failureReason === 'string'
      ? { submissionFailureReason: failureReason }
      : {}),
    ...ledgerFields,
  };
}

/** METADATA attributes the submission ledger reports when present. */
const LEDGER_FIELDS = [
  'nerisIncidentId',
  'nerisStatus',
  'nerisStatusAt',
  'lockedAt',
  'lockedBy',
  'lastPayloadHash',
  'firstSubmittedAt',
  'lastSubmittedAt',
  'updatedAt',
] as const;

export interface SubmissionAttemptInput {
  readonly outcome: SubmissionOutcome;
  readonly httpStatus: number;
  readonly retryCount: number;
  readonly nerisEnvironment: 'DEV' | 'PROD';
  readonly failureReason?: string;
  /**
   * CREATE = POST /incident/{entity}; UPDATE = PUT /incident/{entity}/{nerisId}; ADOPT =
   * NERIS already held the record from an earlier attempt, so it was adopted and replaced.
   */
  readonly operation?: 'CREATE' | 'UPDATE' | 'ADOPT';
  /** NERIS's id for the record, once it has one. */
  readonly nerisIncidentId?: string;
  /** NERIS lifecycle status returned by the create (a PUT returns none). */
  readonly nerisStatus?: string;
  readonly payloadHash?: string;
  /** The one-time EventBridge Scheduler schedule that will run the next retry. */
  readonly retryScheduleName?: string;
  /** The payload NERIS accepted, kept (one row) so a later resubmission can show its diff. */
  readonly acceptedPayload?: Readonly<Record<string, unknown>>;
  /** Who to tell when this attempt ends the send in failure (review M6). */
  readonly notify?: {
    readonly ownerId: string;
    readonly lockedBy?: string;
    readonly incidentNumber: string;
  };
  /** NERIS's own 422 issues, verbatim, for the submission ledger. */
  readonly errors?: readonly {
    readonly path: string;
    readonly code: string;
    readonly message: string;
  }[];
}

/** Poller work-list row: one per incident whose NERIS status is not final yet. */
export function nerisOpenKey(deptId: VerifiedDeptId, incidentId: string) {
  return { pk: buildDeptScopedPk(deptId, 'NERIS_OPEN'), sk: incidentId };
}

export const LAST_PAYLOAD_SK = 'NERIS#LAST_PAYLOAD';

const OPEN_STATUSES = new Set(['SUBMITTED', 'PENDING_INCIDENT_DATA', 'PENDING_APPROVAL']);

export interface AppendSubmissionAttemptResult {
  readonly submissionStatus: SubmissionStatus;
}

export interface EnqueueSubmissionResult {
  readonly submissionStatus: 'SUBMITTED';
}

export interface SubmissionRecord {
  readonly incidentId: string;
  readonly status: string;
  readonly submissionStatus?: SubmissionStatus;
  readonly submissionFailureReason?: string;
  readonly nerisIncidentId?: string;
  readonly nerisStatus?: string;
  readonly nerisStatusAt?: number;
  readonly lockedAt?: number;
  readonly lockedBy?: string;
  readonly lastPayloadHash?: string;
  readonly firstSubmittedAt?: number;
  readonly lastSubmittedAt?: number;
  readonly updatedAt?: number;
}

export interface RetrySubmissionResult {
  readonly submissionStatus: 'RETRYING';
}

export interface SubmissionRepository {
  enqueueSubmission(
    deptId: VerifiedDeptId,
    incidentId: string,
    nowEpochSeconds: number,
    traceId: string,
  ): Promise<EnqueueSubmissionResult>;
  appendSubmissionAttempt(
    deptId: VerifiedDeptId,
    incidentId: string,
    attempt: SubmissionAttemptInput,
    terminal: boolean,
    nowEpochSeconds: number,
  ): Promise<AppendSubmissionAttemptResult>;
  getSubmission(deptId: VerifiedDeptId, incidentId: string): Promise<SubmissionRecord | undefined>;
  retrySubmission(
    deptId: VerifiedDeptId,
    incidentId: string,
    nowEpochSeconds: number,
    traceId: string,
  ): Promise<RetrySubmissionResult>;
  /**
   * Records, before the POST, the NERIS id the create will produce. If the response is lost
   * or the local write after a 201 fails, the next attempt finds this and adopts the record
   * NERIS already holds instead of creating it again (review M2).
   */
  markCreateInFlight(
    deptId: VerifiedDeptId,
    incidentId: string,
    expectedNerisId: string,
  ): Promise<void>;
}

export function createSubmissionRepository(
  client: DynamoDBDocumentClient,
  tableName: string,
): SubmissionRepository {
  return {
    async enqueueSubmission(deptId, incidentId, nowEpochSeconds, traceId) {
      const outboxRecord = buildOutboxRecord(
        deptId,
        'incident-service',
        'neris.incident.submitted',
        traceId,
        {
          incidentId,
          deptId,
        },
      );

      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: tableName,
                  Key: { pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId), sk: 'METADATA' },
                  // Only a report an officer has reviewed and locked, with no send in flight.
                  // A report NERIS already holds goes through resubmit (diff + PUT by id), not
                  // a second submit (review minor 4).
                  ConditionExpression: `attribute_exists(pk) AND #status = :validated AND attribute_exists(lockedAt) AND attribute_not_exists(nerisIncidentId) AND ${NOT_IN_FLIGHT_CONDITION}`,
                  UpdateExpression:
                    'SET #status = :submitted, submissionStatus = :submitted, submissionActivityAt = :activityAt, updatedAt = :updatedAt',
                  ExpressionAttributeNames: { '#status': 'status' },
                  ExpressionAttributeValues: {
                    ':validated': 'VALIDATED' satisfies IncidentStatus,
                    ':submitted': 'SUBMITTED' satisfies IncidentStatus,
                    ':updatedAt': nowEpochSeconds,
                    ':activityAt': new Date().toISOString(),
                    ...inFlightValues(),
                  },
                },
              },
              { Put: { TableName: tableName, Item: outboxRecord } },
            ],
          }),
        );
      } catch (error) {
        if (
          error instanceof TransactionCanceledException &&
          error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
        ) {
          const existing = await client.send(
            new GetCommand({
              TableName: tableName,
              Key: { pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId), sk: 'METADATA' },
            }),
          );
          if (!existing.Item) {
            throw new IncidentNotFoundError(incidentId);
          }
          const item = existing.Item;
          throw new SubmissionConflictError(
            incidentId,
            String(item.status),
            typeof item.lockedAt !== 'number'
              ? 'NOT_LOCKED'
              : isInFlight(item)
                ? 'IN_FLIGHT'
                : typeof item.nerisIncidentId === 'string'
                  ? 'IN_NERIS'
                  : 'NOT_VALIDATED',
          );
        }
        logger.error({
          event: 'neris.submission.enqueue_failed',
          correlationId: traceId,
          deptId,
          incidentId,
          message: error instanceof Error ? error.message : undefined,
        });
        throw error;
      }

      return { submissionStatus: 'SUBMITTED' };
    },

    async appendSubmissionAttempt(deptId, incidentId, attempt, terminal, nowEpochSeconds) {
      const attemptedAt = new Date().toISOString();

      const submissionStatus: SubmissionStatus =
        attempt.outcome === 'SUCCESS' ? 'ACCEPTED' : terminal ? 'FAILED' : 'RETRYING';
      const incidentStatus: IncidentStatus | undefined =
        attempt.outcome === 'SUCCESS'
          ? 'ACCEPTED'
          : attempt.outcome === 'VALIDATION_ERROR'
            ? 'REJECTED'
            : undefined;
      const success = attempt.outcome === 'SUCCESS';

      const attemptItem = {
        pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId),
        sk: `SUBMISSION#${attemptedAt}`,
        entityType: 'NERIS_SUBMISSION_ATTEMPT',
        incidentId,
        deptId,
        attemptedAt,
        outcome: attempt.outcome,
        httpStatus: attempt.httpStatus,
        retryCount: attempt.retryCount,
        nerisEnvironment: attempt.nerisEnvironment,
        ...(attempt.operation ? { operation: attempt.operation } : {}),
        ...(attempt.nerisIncidentId ? { nerisIncidentId: attempt.nerisIncidentId } : {}),
        ...(attempt.nerisStatus ? { nerisStatus: attempt.nerisStatus } : {}),
        ...(attempt.payloadHash ? { payloadHash: attempt.payloadHash } : {}),
        ...(attempt.retryScheduleName ? { retryScheduleName: attempt.retryScheduleName } : {}),
        ...(attempt.failureReason ? { failureReason: attempt.failureReason } : {}),
        ...(attempt.errors && attempt.errors.length > 0 ? { errors: attempt.errors } : {}),
      };

      const setClauses = [
        'submissionStatus = :submissionStatus',
        'lastSubmissionAttemptAt = :attemptedAt',
        'submissionActivityAt = :attemptedAt',
        'updatedAt = :updatedAt',
      ];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {
        ':submissionStatus': submissionStatus,
        ':attemptedAt': attemptedAt,
        ':updatedAt': nowEpochSeconds,
      };
      if (submissionStatus === 'FAILED') {
        setClauses.push('submissionFailureReason = :failureReason');
        values[':failureReason'] = attempt.failureReason ?? attempt.outcome;
      }
      if (incidentStatus) {
        setClauses.push('#status = :incidentStatus');
        names['#status'] = 'status';
        values[':incidentStatus'] = incidentStatus;
      }
      if (success) {
        setClauses.push(
          'firstSubmittedAt = if_not_exists(firstSubmittedAt, :updatedAt)',
          'lastSubmittedAt = :updatedAt',
        );
        if (attempt.nerisIncidentId) {
          setClauses.push('nerisIncidentId = :nerisIncidentId');
          values[':nerisIncidentId'] = attempt.nerisIncidentId;
        }
        if (attempt.payloadHash) {
          setClauses.push('lastPayloadHash = :payloadHash');
          values[':payloadHash'] = attempt.payloadHash;
        }
        // A create reports NERIS's status; a PUT does not, and the record re-enters NERIS's
        // queue, so it reads as SUBMITTED until the poller fetches the real one.
        setClauses.push('nerisStatus = :nerisStatus', 'nerisStatusAt = :updatedAt');
        values[':nerisStatus'] = attempt.nerisStatus ?? 'SUBMITTED';
      }
      const watchStatus = success && OPEN_STATUSES.has(attempt.nerisStatus ?? 'SUBMITTED');

      const failedOutboxRecord =
        submissionStatus === 'FAILED'
          ? buildOutboxRecord(deptId, 'incident-service', 'neris.submission.failed', incidentId, {
              incidentId,
              deptId,
              reason: attempt.failureReason ?? attempt.outcome,
              // reporting-service's projection (projections/events.ts) reads these two names.
              failureReason: attempt.failureReason ?? attempt.outcome,
              httpStatus: attempt.httpStatus,
              outcome: attempt.outcome,
              // notification-service tells the owner, the locking officer and officers.
              ...(attempt.notify
                ? {
                    ownerId: attempt.notify.ownerId,
                    ...(attempt.notify.lockedBy ? { lockedBy: attempt.notify.lockedBy } : {}),
                    incidentNumber: attempt.notify.incidentNumber,
                  }
                : {}),
            })
          : undefined;

      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: attemptItem,
                  ConditionExpression: 'attribute_not_exists(sk)',
                },
              },
              {
                Update: {
                  TableName: tableName,
                  Key: { pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId), sk: 'METADATA' },
                  ConditionExpression: 'attribute_exists(pk)',
                  UpdateExpression: `SET ${setClauses.join(', ')}${success ? ' REMOVE pendingNerisId' : ''}`,
                  ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
                  ExpressionAttributeValues: values,
                },
              },
              ...(failedOutboxRecord
                ? [{ Put: { TableName: tableName, Item: failedOutboxRecord } }]
                : []),
              ...(success && attempt.acceptedPayload
                ? [
                    {
                      Put: {
                        TableName: tableName,
                        Item: {
                          pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId),
                          sk: LAST_PAYLOAD_SK,
                          entityType: 'NERIS_LAST_PAYLOAD',
                          payload: attempt.acceptedPayload,
                          payloadHash: attempt.payloadHash,
                          acceptedAt: attemptedAt,
                        },
                      },
                    },
                  ]
                : []),
              ...(watchStatus && attempt.nerisIncidentId
                ? [
                    {
                      Put: {
                        TableName: tableName,
                        Item: {
                          ...nerisOpenKey(deptId, incidentId),
                          entityType: 'NERIS_OPEN_SUBMISSION',
                          incidentId,
                          nerisIncidentId: attempt.nerisIncidentId,
                          since: nowEpochSeconds,
                        },
                      },
                    },
                  ]
                : []),
              ...(success
                ? [
                    {
                      Put: {
                        TableName: tableName,
                        Item: buildOutboxRecord(
                          deptId,
                          'incident-service',
                          'neris.incident.transmitted',
                          incidentId,
                          {
                            incidentId,
                            deptId,
                            operation: attempt.operation ?? 'CREATE',
                            ...(attempt.nerisIncidentId
                              ? { nerisIncidentId: attempt.nerisIncidentId }
                              : {}),
                            nerisStatus: attempt.nerisStatus ?? 'SUBMITTED',
                          },
                        ),
                      },
                    },
                  ]
                : []),
            ],
          }),
        );
      } catch (error) {
        if (
          error instanceof TransactionCanceledException &&
          error.CancellationReasons?.[1]?.Code === 'ConditionalCheckFailed'
        ) {
          throw new IncidentNotFoundError(incidentId);
        }
        logger.error({
          event: 'neris.submission.append_attempt_failed',
          correlationId: incidentId,
          deptId,
          incidentId,
          outcome: attempt.outcome,
          message: error instanceof Error ? error.message : undefined,
        });
        throw error;
      }

      return { submissionStatus };
    },

    async markCreateInFlight(deptId, incidentId, expectedNerisId) {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId), sk: 'METADATA' },
          ConditionExpression: 'attribute_exists(pk)',
          UpdateExpression: 'SET pendingNerisId = :expected, pendingCreateAt = :at',
          ExpressionAttributeValues: {
            ':expected': expectedNerisId,
            ':at': new Date().toISOString(),
          },
        }),
      );
    },

    async getSubmission(deptId, incidentId) {
      const existing = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId), sk: 'METADATA' },
          ConsistentRead: true,
        }),
      );
      if (!existing.Item) {
        return undefined;
      }
      return toSubmissionRecord(incidentId, existing.Item as Record<string, unknown>);
    },

    async retrySubmission(deptId, incidentId, nowEpochSeconds, traceId) {
      const outboxRecord = buildOutboxRecord(
        deptId,
        'incident-service',
        'neris.incident.submitted',
        traceId,
        {
          incidentId,
          deptId,
        },
      );

      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: tableName,
                  Key: { pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId), sk: 'METADATA' },
                  // A retry resends what an officer locked; an unlocked report goes back
                  // through review first.
                  ConditionExpression:
                    'attribute_exists(pk) AND attribute_exists(lockedAt) AND (submissionStatus = :failed OR ((submissionStatus = :queued OR submissionStatus = :retrying) AND (attribute_not_exists(submissionActivityAt) OR submissionActivityAt < :staleBefore)))',
                  UpdateExpression:
                    'SET submissionStatus = :retrying, submissionActivityAt = :activityAt, updatedAt = :updatedAt REMOVE submissionFailureReason',
                  ExpressionAttributeValues: {
                    ':failed': 'FAILED' satisfies SubmissionStatus,
                    ':updatedAt': nowEpochSeconds,
                    ':activityAt': new Date().toISOString(),
                    ...inFlightValues(),
                  },
                },
              },
              { Put: { TableName: tableName, Item: outboxRecord } },
            ],
          }),
        );
      } catch (error) {
        if (
          error instanceof TransactionCanceledException &&
          error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
        ) {
          const existing = await client.send(
            new GetCommand({
              TableName: tableName,
              Key: { pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId), sk: 'METADATA' },
            }),
          );
          if (!existing.Item) {
            throw new IncidentNotFoundError(incidentId);
          }
          throw new SubmissionRetryConflictError(
            incidentId,
            String(existing.Item.submissionStatus ?? existing.Item.status),
          );
        }
        logger.error({
          event: 'neris.submission.retry_failed',
          correlationId: traceId,
          deptId,
          incidentId,
          message: error instanceof Error ? error.message : undefined,
        });
        throw error;
      }

      return { submissionStatus: 'RETRYING' };
    },
  };
}

let cachedRepository: SubmissionRepository | undefined;

export function getSubmissionRepository(env: NodeJS.ProcessEnv): SubmissionRepository {
  cachedRepository ??= createSubmissionRepository(getDocumentClient(), getTableName(env));
  return cachedRepository;
}
