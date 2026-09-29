import { describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  ReviewConflictError,
  enqueueResubmission,
  lockIncident,
  unlockIncident,
} from './reviewRepository.js';

const DEPT = toVerifiedDeptId({ deptId: 'NICHOLS' });
const ID = 'NICHOLS-4471-1798000000';

interface Command {
  readonly constructor: { name: string };
  readonly input: Record<string, unknown>;
}

type Item = Record<string, Record<string, unknown>>;

function transactItems(send: ReturnType<typeof vi.fn>): Item[] {
  const command = send.mock.calls
    .map(([c]) => c as Command)
    .find((c) => c.constructor.name === 'TransactWriteCommand')!;
  return command.input.TransactItems as Item[];
}

function cancelled(): TransactionCanceledException {
  return new TransactionCanceledException({
    message: 'cancelled',
    $metadata: {},
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
  });
}

const client = (send: ReturnType<typeof vi.fn>) => ({ send }) as unknown as DynamoDBDocumentClient;

const LOCK = {
  deptId: DEPT,
  incidentId: ID,
  actorId: 'MBR-0034',
  reviewedUpdatedAt: 1_798_000_500,
  previousStatus: 'DRAFT' as const,
  nowEpochSeconds: 1_798_003_000,
  traceId: 'trace',
};

describe('lockIncident', () => {
  it('locks conditionally on the reviewed updatedAt, audits, and emits incident.report.locked', async () => {
    const send = vi.fn().mockResolvedValue({});
    const result = await lockIncident(client(send), 'table', { ...LOCK, submit: false });

    expect(result).toEqual({ status: 'VALIDATED' });
    const [update, audit, locked, ...rest] = transactItems(send);
    expect(update!.Update).toMatchObject({
      ConditionExpression:
        'attribute_exists(pk) AND attribute_not_exists(lockedAt) AND updatedAt = :reviewed AND (attribute_not_exists(submissionStatus) OR (submissionStatus <> :queued AND submissionStatus <> :retrying))',
      ExpressionAttributeValues: { ':reviewed': 1_798_000_500, ':status': 'VALIDATED' },
    });
    expect(String(update!.Update!.UpdateExpression)).not.toContain('updatedAt =');
    expect(audit!.Put!.Item).toMatchObject({ entityType: 'AUDIT_LOG_ENTRY', action: 'LOCK' });
    expect(locked!.Put!.Item).toMatchObject({ eventType: 'incident.report.locked' });
    expect(rest).toEqual([]);
  });

  it('queues the NERIS submission in the same transaction when asked to', async () => {
    const send = vi.fn().mockResolvedValue({});
    const result = await lockIncident(client(send), 'table', { ...LOCK, submit: true });

    expect(result).toEqual({ status: 'SUBMITTED', submissionStatus: 'SUBMITTED' });
    const items = transactItems(send);
    expect(items[0]!.Update).toMatchObject({
      ExpressionAttributeValues: { ':status': 'SUBMITTED', ':queued': 'SUBMITTED' },
    });
    expect(items[3]!.Put!.Item).toMatchObject({
      eventType: 'neris.incident.submitted',
      payload: { incidentId: ID, deptId: 'NICHOLS' },
    });
  });

  it('explains a failed condition: missing, already locked, or changed since review', async () => {
    for (const [item, conflict] of [
      [undefined, 'NOT_FOUND'],
      [{ lockedAt: 1 }, 'ALREADY_LOCKED'],
      [{ updatedAt: 1_798_000_900 }, 'CHANGED_SINCE_REVIEW'],
      [{ updatedAt: 1_798_000_500, submissionStatus: 'RETRYING' }, 'SUBMISSION_IN_FLIGHT'],
    ] as const) {
      const send = vi.fn().mockRejectedValueOnce(cancelled()).mockResolvedValueOnce({ Item: item });
      await expect(lockIncident(client(send), 'table', { ...LOCK, submit: false })).rejects.toEqual(
        new ReviewConflictError(conflict),
      );
    }
  });
});

describe('unlockIncident', () => {
  const UNLOCK = {
    deptId: DEPT,
    incidentId: ID,
    actorId: 'MBR-0001',
    reason: 'E1 times were wrong',
    nowEpochSeconds: 1_798_005_000,
    traceId: 'trace',
  };

  it('removes the lock, records the reason in the audit row and the outbox', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: { lockedAt: 1_798_003_000, submissionStatus: 'ACCEPTED' } })
      .mockResolvedValue({});
    await unlockIncident(client(send), 'table', UNLOCK);

    const [update, audit, outbox] = transactItems(send);
    expect(String(update!.Update!.UpdateExpression)).toContain('REMOVE lockedAt, lockedBy');
    // Back to DRAFT, so nothing can be submitted until it is reviewed and locked again.
    expect(update!.Update!.ExpressionAttributeValues).toMatchObject({ ':draft': 'DRAFT' });
    expect(audit!.Put!.Item).toMatchObject({ action: 'UNLOCK', reason: 'E1 times were wrong' });
    expect(outbox!.Put!.Item).toMatchObject({
      eventType: 'incident.report.unlocked',
      payload: { reason: 'E1 times were wrong', unlockedBy: 'MBR-0001' },
    });
  });

  it('refuses an unlocked report and one whose NERIS submission is in flight', async () => {
    await expect(
      unlockIncident(client(vi.fn().mockResolvedValue({ Item: {} })), 'table', UNLOCK),
    ).rejects.toEqual(new ReviewConflictError('NOT_LOCKED'));
    for (const submissionStatus of ['SUBMITTED', 'RETRYING']) {
      await expect(
        unlockIncident(
          client(vi.fn().mockResolvedValue({ Item: { lockedAt: 1, submissionStatus } })),
          'table',
          UNLOCK,
        ),
      ).rejects.toEqual(new ReviewConflictError('SUBMISSION_IN_FLIGHT'));
    }
  });
});

describe('enqueueResubmission', () => {
  it('requires the lock, a NERIS id and no submission in flight, and emits submitted + resubmitted', async () => {
    const send = vi.fn().mockResolvedValue({});
    await enqueueResubmission(client(send), 'table', {
      deptId: DEPT,
      incidentId: ID,
      actorId: 'MBR-0034',
      changeCount: 2,
      nowEpochSeconds: 1_798_006_000,
      traceId: 'trace',
    });
    const [update, submitted, resubmitted] = transactItems(send);
    expect(String(update!.Update!.ConditionExpression)).toContain(
      'attribute_exists(lockedAt) AND attribute_exists(nerisIncidentId)',
    );
    expect(submitted!.Put!.Item).toMatchObject({ eventType: 'neris.incident.submitted' });
    expect(resubmitted!.Put!.Item).toMatchObject({
      eventType: 'neris.incident.resubmitted',
      payload: { changeCount: 2 },
    });
  });
});
