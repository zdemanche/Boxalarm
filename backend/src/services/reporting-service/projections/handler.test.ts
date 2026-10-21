import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@boxalarm/metrics', () => ({ emitOutcomeMetric: vi.fn() }));
vi.mock('../logger.js', () => ({ logError: vi.fn(), logger: { error: vi.fn() } }));

import { handleProjectionBatch } from './handler.js';

function sqs(body: string, messageId = 'msg-1'): SQSEvent {
  return { Records: [{ messageId, body } as SQSEvent['Records'][number]] };
}

describe('projection batch handler', () => {
  it('reports a partial batch failure for a malformed record and keeps going', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as DynamoDBDocumentClient;
    const result = await handleProjectionBatch(
      {
        Records: [
          { messageId: 'bad', body: '{' } as SQSEvent['Records'][number],
          {
            messageId: 'good',
            body: JSON.stringify({
              eventId: 'evt-1',
              eventType: 'personnel.member.updated',
              payload: { deptId: 'NICHOLS', memberId: 'm-1', newStatus: 'ACTIVE' },
            }),
          } as SQSEvent['Records'][number],
        ],
      },
      client,
      'platform',
    );
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad' }]);
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not fail the batch when the dedup item already exists', async () => {
    const { TransactionCanceledException } = await import('@aws-sdk/client-dynamodb');
    const send = vi.fn().mockRejectedValue(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      }),
    );
    const client = { send } as unknown as DynamoDBDocumentClient;
    const result = await handleProjectionBatch(
      sqs(
        JSON.stringify({
          eventId: 'evt-1',
          eventType: 'neris.incident.submitted',
          payload: { departmentId: 'NICHOLS', incidentId: 'inc-1', submissionStatus: 'SUBMITTED' },
        }),
      ),
      client,
      'platform',
    );
    expect(result.batchItemFailures).toEqual([]);
  });

  it('acknowledges a stale event without failing the batch', async () => {
    const { TransactionCanceledException } = await import('@aws-sdk/client-dynamodb');
    const send = vi.fn().mockRejectedValue(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
      }),
    );
    const client = { send } as unknown as DynamoDBDocumentClient;
    const result = await handleProjectionBatch(
      sqs(
        JSON.stringify({
          eventId: 'evt-1',
          eventTime: '2026-03-01T12:00:00.000Z',
          eventType: 'personnel.availability.changed',
          payload: { deptId: 'NICHOLS', memberId: 'm-1', availabilityState: 'MARKED_OFF' },
        }),
      ),
      client,
      'platform',
    );
    expect(result.batchItemFailures).toEqual([]);
  });
});
