import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
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

export class SubmissionConflictError extends Error {
  constructor(incidentId: string, currentStatus: string) {
    super(
      `incident "${incidentId}" is not VALIDATED and cannot be submitted (current status "${currentStatus}")`,
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
  return {
    incidentId,
    status: typeof item.status === 'string' ? item.status : '',
    ...(submissionStatus !== undefined ? { submissionStatus } : {}),
    ...(submissionStatus === 'FAILED' && typeof failureReason === 'string'
      ? { submissionFailureReason: failureReason }
      : {}),
  };
}

export interface SubmissionAttemptInput {
  readonly outcome: SubmissionOutcome;
  readonly httpStatus: number;
  readonly retryCount: number;
  readonly nerisEnvironment: 'DEV' | 'PROD';
  readonly failureReason?: string;
  /** CREATE = POST /incident/{entity}; UPDATE = PUT /incident/{entity}/{nerisId}. */
  readonly operation?: 'CREATE' | 'UPDATE';
  /** NERIS's id for the record, once it has one. */
  readonly nerisIncidentId?: string;
  /** NERIS lifecycle status returned by the create (a PUT returns none). */
  readonly nerisStatus?: string;
  readonly payloadHash?: string;
  /** The payload NERIS accepted, kept (one row) so a later resubmission can show its diff. */
  readonly acceptedPayload?: Readonly<Record<string, unknown>>;
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
                  ConditionExpression: 'attribute_exists(pk) AND #status = :validated',
                  UpdateExpression:
                    'SET #status = :submitted, submissionStatus = :submitted, updatedAt = :updatedAt',
                  ExpressionAttributeNames: { '#status': 'status' },
                  ExpressionAttributeValues: {
                    ':validated': 'VALIDATED' satisfies IncidentStatus,
                    ':submitted': 'SUBMITTED' satisfies IncidentStatus,
                    ':updatedAt': nowEpochSeconds,
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
          throw new SubmissionConflictError(incidentId, String(existing.Item.status));
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
        ...(attempt.failureReason ? { failureReason: attempt.failureReason } : {}),
        ...(attempt.errors && attempt.errors.length > 0 ? { errors: attempt.errors } : {}),
      };

      const setClauses = [
        'submissionStatus = :submissionStatus',
        'lastSubmissionAttemptAt = :attemptedAt',
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
                  UpdateExpression: `SET ${setClauses.join(', ')}`,
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
                  ConditionExpression: 'attribute_exists(pk) AND submissionStatus = :failed',
                  UpdateExpression:
                    'SET submissionStatus = :retrying, updatedAt = :updatedAt REMOVE submissionFailureReason',
                  ExpressionAttributeValues: {
                    ':failed': 'FAILED' satisfies SubmissionStatus,
                    ':retrying': 'RETRYING' satisfies SubmissionStatus,
                    ':updatedAt': nowEpochSeconds,
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
