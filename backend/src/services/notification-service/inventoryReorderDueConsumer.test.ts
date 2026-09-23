import { describe, expect, it, vi } from 'vitest';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { handler } from './inventoryReorderDueConsumer.js';

function record(body: string, messageId = 'msg-1'): SQSRecord {
  return { messageId, body } as SQSRecord;
}

function sqsEvent(...records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

const validDetail = {
  eventId: 'evt-1',
  eventTime: '2026-09-14T12:00:00Z',
  eventType: 'inventory.reorder.due',
  source: 'inventory-service',
  correlationId: 'trace-1',
  schemaVersion: '1.0',
  payload: {
    itemId: 'GLOVES-L',
    itemName: 'Gloves (Large)',
    currentQty: 3,
    reorderThreshold: 5,
    deptId: 'NICHOLS',
  },
};

describe('inventoryReorderDueConsumer handler (entrypoint-test — the exported Lambda handler)', () => {
  it('AC2: decodes the EventBridge envelope and routes to handleInventoryReorderDue (stub, non-critical channel)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handler(
      sqsEvent(record(JSON.stringify({ detail: validDetail }))),
      {} as never,
      () => undefined,
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.event).toBe('notification.inventory_reorder_due.stub');
    expect(logged.channelClass).toBe('non-critical');
    expect(logged.itemId).toBe('GLOVES-L');
    expect(logged.correlationId).toBe('trace-1');
    logSpy.mockRestore();
  });

  it('logs the original error and rejects (fail-closed, so SQS/DLQ redelivers) on a malformed message', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      handler(sqsEvent(record('not-json', 'msg-bad')), {} as never, () => undefined),
    ).rejects.toThrow();

    const logged = errorSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === 'notification.inventory_reorder_due.malformed');
    expect(logged?.correlationId).toBe('msg-bad');
    errorSpy.mockRestore();
  });

  it('rejects a message whose detail fails shape validation (missing payload fields)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      handler(
        sqsEvent(record(JSON.stringify({ detail: { eventType: 'inventory.reorder.due' } }))),
        {} as never,
        () => undefined,
      ),
    ).rejects.toThrow();

    errorSpy.mockRestore();
  });
});
