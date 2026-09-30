import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { parseConfigUpdated } from '../../alerting-service/alertRules/alertRulesCopyHandler.js';
import { buildReemitRecord, reemitAlertRules } from './reemitAlertRules.js';

describe('ALERT_RULES backfill re-emit (review MINOR-7)', () => {
  it('re-emits the saved rules as the platform.config.updated outbox row the alerting consumer reads', async () => {
    const row = { version: 4, value: { toneLadder: { tone2AtSeconds: 150 } }, updatedBy: 'chief' };
    const send = vi.fn((command: { constructor: { name: string } }) =>
      Promise.resolve(command.constructor.name === 'GetCommand' ? { Item: row } : {}),
    );

    await expect(
      reemitAlertRules({ send } as unknown as DynamoDBDocumentClient, 'platform', 'nichols-fd'),
    ).resolves.toBe('reemitted');

    const put = (send.mock.calls[1]![0] as unknown as { input: { Item: Record<string, unknown> } })
      .input.Item;
    expect(put).toMatchObject({
      pk: 'DEPT#nichols-fd#OUTBOX',
      entityType: 'OUTBOX_ENTRY',
      eventType: 'platform.config.updated',
      source: 'platform-service',
      sentAt: null,
    });
    // The consumer accepts it exactly as the drain would deliver it.
    const body = JSON.stringify({
      detail: { eventType: put.eventType, eventTime: put.eventTime, payload: put.payload },
    });
    expect(parseConfigUpdated(body)).toEqual({
      kind: 'alert-rules',
      update: {
        deptId: 'nichols-fd',
        version: 4,
        value: row.value,
        eventTime: put.eventTime,
      },
    });
  });

  it('does nothing for a department that never saved ALERT_RULES', async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      reemitAlertRules({ send } as unknown as DynamoDBDocumentClient, 'platform', 'nichols-fd'),
    ).resolves.toBe('no-rules');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('builds a fresh event id per row', () => {
    const a = buildReemitRecord('d', { version: 1, value: {} });
    const b = buildReemitRecord('d', { version: 1, value: {} });
    expect(a.eventId).not.toBe(b.eventId);
  });
});
