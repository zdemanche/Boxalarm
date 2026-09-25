import { describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { IncidentNotFoundError } from './repository.js';
import {
  SubmissionConflictError,
  SubmissionRetryConflictError,
  createSubmissionRepository,
} from './submissionRepository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE_NAME = 'boxalarm-dev-incident';
const INCIDENT_ID = 'NICHOLS-4471-1798000000';
const TRACE_ID = 'trace-abc-123';

function fakeClient(send: (command: unknown) => unknown): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

function conditionalCheckFailed(
  reasons: (Record<string, unknown> | undefined)[],
): TransactionCanceledException {
  const error = new TransactionCanceledException({
    message: 'transaction cancelled',
    $metadata: {},
    CancellationReasons: reasons.map((reason) => ({ Code: 'ConditionalCheckFailed', ...reason })),
  });
  return error;
}

describe('createSubmissionRepository.enqueueSubmission', () => {
  it('transitions status to SUBMITTED conditioned on VALIDATED and writes the neris.incident.submitted outbox record (AC1)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createSubmissionRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.enqueueSubmission(
      DEPT_ID,
      INCIDENT_ID,
      1_798_000_100,
      TRACE_ID,
    );

    expect(result).toEqual({ submissionStatus: 'SUBMITTED' });
    const [command] = send.mock.calls[0] as [
      {
        input: {
          TransactItems: [
            { Update: Record<string, unknown> },
            { Put: { Item: Record<string, unknown> } },
          ];
        };
      },
    ];
    const update = command.input.TransactItems[0].Update;
    expect(update).toMatchObject({
      TableName: TABLE_NAME,
      Key: { pk: `DEPT#NICHOLS#INCIDENT#${INCIDENT_ID}`, sk: 'METADATA' },
      ConditionExpression: 'attribute_exists(pk) AND #status = :validated',
    });
    const outboxItem = command.input.TransactItems[1].Put.Item;
    expect(outboxItem).toMatchObject({
      entityType: 'OUTBOX_ENTRY',
      eventType: 'neris.incident.submitted',
      source: 'incident-service',
      correlationId: TRACE_ID,
      payload: { incidentId: INCIDENT_ID, deptId: 'NICHOLS' },
    });
  });

  it('throws IncidentNotFoundError when the incident does not exist', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(conditionalCheckFailed([{}]))
      .mockResolvedValueOnce({});
    const repository = createSubmissionRepository(fakeClient(send), TABLE_NAME);

    await expect(
      repository.enqueueSubmission(DEPT_ID, INCIDENT_ID, 1_798_000_100, TRACE_ID),
    ).rejects.toBeInstanceOf(IncidentNotFoundError);
  });

  it('throws SubmissionConflictError (409) when the incident is not VALIDATED (AC1)', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(conditionalCheckFailed([{}]))
      .mockResolvedValueOnce({ Item: { status: 'DRAFT' } });
    const repository = createSubmissionRepository(fakeClient(send), TABLE_NAME);

    await expect(
      repository.enqueueSubmission(DEPT_ID, INCIDENT_ID, 1_798_000_100, TRACE_ID),
    ).rejects.toBeInstanceOf(SubmissionConflictError);
  });
});

describe('createSubmissionRepository.appendSubmissionAttempt', () => {
  it('appends a NERIS_SUBMISSION_ATTEMPT with a unique sk guard and never overwrites a prior attempt (AC2)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createSubmissionRepository(fakeClient(send), TABLE_NAME);

    await repository.appendSubmissionAttempt(
      DEPT_ID,
      INCIDENT_ID,
      { outcome: 'RATE_LIMITED', httpStatus: 429, retryCount: 0, nerisEnvironment: 'DEV' },
      false,
      1_798_000_200,
    );

    const [command] = send.mock.calls[0] as [
      {
        input: {
          TransactItems: [
            { Put: { Item: Record<string, unknown>; ConditionExpression: string } },
            ...unknown[],
          ];
        };
      },
    ];
    const attemptPut = command.input.TransactItems[0].Put;
    expect(attemptPut.ConditionExpression).toBe('attribute_not_exists(sk)');
    expect(attemptPut.Item).toMatchObject({
      entityType: 'NERIS_SUBMISSION_ATTEMPT',
      incidentId: INCIDENT_ID,
      outcome: 'RATE_LIMITED',
      httpStatus: 429,
      retryCount: 0,
      nerisEnvironment: 'DEV',
    });
    expect(String(attemptPut.Item.sk)).toMatch(/^SUBMISSION#/);
  });

  it('sets submissionStatus RETRYING (not FAILED) and writes no failure outbox record for a non-terminal RATE_LIMITED attempt', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createSubmissionRepository(fakeClient(send), TABLE_NAME);

    await repository.appendSubmissionAttempt(
      DEPT_ID,
      INCIDENT_ID,
      { outcome: 'RATE_LIMITED', httpStatus: 429, retryCount: 0, nerisEnvironment: 'DEV' },
      false,
      1_798_000_200,
    );

    const [command] = send.mock.calls[0] as [{ input: { TransactItems: unknown[] } }];
    expect(command.input.TransactItems).toHaveLength(2);
  });

  it('sets status ACCEPTED on the incident and submissionStatus ACCEPTED on a SUCCESS outcome (AC4)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createSubmissionRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.appendSubmissionAttempt(
      DEPT_ID,
      INCIDENT_ID,
      { outcome: 'SUCCESS', httpStatus: 200, retryCount: 0, nerisEnvironment: 'DEV' },
      true,
      1_798_000_200,
    );

    expect(result).toEqual({ submissionStatus: 'ACCEPTED' });
    const [command] = send.mock.calls[0] as [
      {
        input: {
          TransactItems: [
            unknown,
            { Update: { ExpressionAttributeValues: Record<string, unknown> } },
          ];
        };
      },
    ];
    const update = command.input.TransactItems[1].Update;
    expect(update.ExpressionAttributeValues[':submissionStatus']).toBe('ACCEPTED');
    expect(update.ExpressionAttributeValues[':incidentStatus']).toBe('ACCEPTED');
  });

  it('sets submissionStatus FAILED, incident status REJECTED, and writes a neris.submission.failed outbox record on a terminal VALIDATION_ERROR (E6-S9 AC1)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createSubmissionRepository(fakeClient(send), TABLE_NAME);

    await repository.appendSubmissionAttempt(
      DEPT_ID,
      INCIDENT_ID,
      { outcome: 'VALIDATION_ERROR', httpStatus: 400, retryCount: 0, nerisEnvironment: 'DEV' },
      true,
      1_798_000_200,
    );

    const [command] = send.mock.calls[0] as [
      {
        input: {
          TransactItems: [
            unknown,
            { Update: { ExpressionAttributeValues: Record<string, unknown> } },
            { Put: { Item: Record<string, unknown> } },
          ];
        };
      },
    ];
    const update = command.input.TransactItems[1].Update;
    expect(update.ExpressionAttributeValues[':submissionStatus']).toBe('FAILED');
    expect(update.ExpressionAttributeValues[':incidentStatus']).toBe('REJECTED');
    const failedOutboxItem = command.input.TransactItems[2].Put.Item;
    expect(failedOutboxItem).toMatchObject({
      entityType: 'OUTBOX_ENTRY',
      eventType: 'neris.submission.failed',
      payload: { incidentId: INCIDENT_ID, deptId: 'NICHOLS' },
    });
  });

  it('sets submissionStatus FAILED after retries are exhausted on SERVER_ERROR, without changing incident status', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createSubmissionRepository(fakeClient(send), TABLE_NAME);

    await repository.appendSubmissionAttempt(
      DEPT_ID,
      INCIDENT_ID,
      { outcome: 'SERVER_ERROR', httpStatus: 503, retryCount: 5, nerisEnvironment: 'DEV' },
      true,
      1_798_000_200,
    );

    const [command] = send.mock.calls[0] as [
      {
        input: {
          TransactItems: [
            unknown,
            { Update: { ExpressionAttributeValues: Record<string, unknown> } },
            unknown,
          ];
        };
      },
    ];
    const update = command.input.TransactItems[1].Update;
    expect(update.ExpressionAttributeValues[':submissionStatus']).toBe('FAILED');
    expect(update.ExpressionAttributeValues[':incidentStatus']).toBeUndefined();
  });

  it('throws IncidentNotFoundError when the incident row is missing', async () => {
    const send = vi.fn().mockRejectedValueOnce(conditionalCheckFailed([{ Code: 'None' }, {}]));
    const repository = createSubmissionRepository(fakeClient(send), TABLE_NAME);

    await expect(
      repository.appendSubmissionAttempt(
        DEPT_ID,
        INCIDENT_ID,
        { outcome: 'SUCCESS', httpStatus: 200, retryCount: 0, nerisEnvironment: 'DEV' },
        true,
        1_798_000_200,
      ),
    ).rejects.toBeInstanceOf(IncidentNotFoundError);
  });
});

describe('createSubmissionRepository.getSubmission', () => {
  it('reads the incident row directly with a consistent GetItem on the dept-scoped key (AC4)', async () => {
    const send = vi.fn().mockResolvedValue({
      Item: {
        status: 'REJECTED',
        submissionStatus: 'FAILED',
        submissionFailureReason: 'NERIS rejected the submission with HTTP 400',
      },
    });
    const repository = createSubmissionRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.getSubmission(DEPT_ID, INCIDENT_ID);

    expect(result).toEqual({
      incidentId: INCIDENT_ID,
      status: 'REJECTED',
      submissionStatus: 'FAILED',
      submissionFailureReason: 'NERIS rejected the submission with HTTP 400',
    });
    const [command] = send.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(command.input).toMatchObject({
      TableName: TABLE_NAME,
      Key: { pk: `DEPT#NICHOLS#INCIDENT#${INCIDENT_ID}`, sk: 'METADATA' },
      ConsistentRead: true,
    });
  });

  it('omits submissionFailureReason unless the submission status is FAILED', async () => {
    const send = vi.fn().mockResolvedValue({
      Item: {
        status: 'SUBMITTED',
        submissionStatus: 'RETRYING',
        submissionFailureReason: 'stale reason',
      },
    });
    const repository = createSubmissionRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.getSubmission(DEPT_ID, INCIDENT_ID);

    expect(result).toEqual({
      incidentId: INCIDENT_ID,
      status: 'SUBMITTED',
      submissionStatus: 'RETRYING',
    });
  });

  it('returns undefined when the incident is not in the caller dept', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createSubmissionRepository(fakeClient(send), TABLE_NAME);

    await expect(repository.getSubmission(DEPT_ID, INCIDENT_ID)).resolves.toBeUndefined();
  });
});

describe('createSubmissionRepository.retrySubmission', () => {
  it('sets submissionStatus RETRYING only from FAILED and writes a neris.incident.submitted outbox row, without a NERIS_SUBMISSION_ATTEMPT (AC2)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createSubmissionRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.retrySubmission(DEPT_ID, INCIDENT_ID, 1_798_000_300, TRACE_ID);

    expect(result).toEqual({ submissionStatus: 'RETRYING' });
    const [command] = send.mock.calls[0] as [
      {
        input: {
          TransactItems: [
            { Update: Record<string, unknown> },
            { Put: { Item: Record<string, unknown> } },
          ];
        };
      },
    ];
    expect(command.input.TransactItems).toHaveLength(2);
    const update = command.input.TransactItems[0].Update;
    expect(update).toMatchObject({
      TableName: TABLE_NAME,
      Key: { pk: `DEPT#NICHOLS#INCIDENT#${INCIDENT_ID}`, sk: 'METADATA' },
      ConditionExpression: 'attribute_exists(pk) AND submissionStatus = :failed',
    });
    expect(update.ExpressionAttributeValues).toMatchObject({
      ':failed': 'FAILED',
      ':retrying': 'RETRYING',
      ':updatedAt': 1_798_000_300,
    });
    expect(String(update.UpdateExpression)).toContain('submissionStatus = :retrying');
    expect(String(update.UpdateExpression)).toContain('REMOVE submissionFailureReason');
    const outboxItem = command.input.TransactItems[1].Put.Item;
    expect(outboxItem).toMatchObject({
      entityType: 'OUTBOX_ENTRY',
      eventType: 'neris.incident.submitted',
      source: 'incident-service',
      correlationId: TRACE_ID,
      payload: { incidentId: INCIDENT_ID, deptId: 'NICHOLS' },
    });
    expect(outboxItem.entityType).not.toBe('NERIS_SUBMISSION_ATTEMPT');
  });

  it('throws IncidentNotFoundError when the incident does not exist', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(conditionalCheckFailed([{}]))
      .mockResolvedValueOnce({});
    const repository = createSubmissionRepository(fakeClient(send), TABLE_NAME);

    await expect(
      repository.retrySubmission(DEPT_ID, INCIDENT_ID, 1_798_000_300, TRACE_ID),
    ).rejects.toBeInstanceOf(IncidentNotFoundError);
  });

  it('throws SubmissionRetryConflictError when submissionStatus is not FAILED', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(conditionalCheckFailed([{}]))
      .mockResolvedValueOnce({ Item: { status: 'SUBMITTED', submissionStatus: 'SUBMITTED' } });
    const repository = createSubmissionRepository(fakeClient(send), TABLE_NAME);

    await expect(
      repository.retrySubmission(DEPT_ID, INCIDENT_ID, 1_798_000_300, TRACE_ID),
    ).rejects.toBeInstanceOf(SubmissionRetryConflictError);
  });
});
