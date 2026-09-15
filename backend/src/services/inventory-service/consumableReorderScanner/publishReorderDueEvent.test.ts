import { describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutEventsCommand, type EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { publishReorderDueEvent } from './publishReorderDueEvent.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'boxalarm-platform';
const env = { PLATFORM_EVENT_BUS_NAME: 'boxalarm-test-platform-bus' };

function fakeDdb(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

function fakeEb(send: ReturnType<typeof vi.fn>): EventBridgeClient {
  return { send } as unknown as EventBridgeClient;
}

const baseParams = {
  deptId,
  itemId: 'GLOVES-L',
  itemName: 'Gloves (Large)',
  currentQty: 3,
  reorderThreshold: 5,
  correlationId: 'trace-1',
  now: new Date('2026-09-14T12:00:00Z'),
};

describe('publishReorderDueEvent', () => {
  it('writes the dedup marker, publishes exactly one well-formed inventory.reorder.due event, then marks it published (AC2, contract)', async () => {
    const ddbSend = vi.fn().mockResolvedValue({});
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'evt-1' }] });
    const ddb = fakeDdb(ddbSend);
    const eb = fakeEb(ebSend);

    const outcome = await publishReorderDueEvent(ddb, eb, env, TABLE, baseParams);

    expect(outcome).toBe('Published');
    const putCommand = ddbSend.mock.calls[0]?.[0] as PutCommand;
    expect(putCommand).toBeInstanceOf(PutCommand);
    expect(putCommand.input.Item?.pk).toBe('DEPT#NICHOLS#CONSUMABLE_REORDER_FLAG#2026-09-14');
    expect(putCommand.input.Item?.sk).toBe('CONSUMABLE#GLOVES-L');

    const updateCommand = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCommand).toBeInstanceOf(UpdateCommand);
    expect(updateCommand.input.ConditionExpression).toBe('attribute_exists(pk)');

    expect(ebSend).toHaveBeenCalledTimes(1);
    const putEvents = ebSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(putEvents).toBeInstanceOf(PutEventsCommand);
    const entry = putEvents.input.Entries?.[0];
    expect(entry?.EventBusName).toBe('boxalarm-test-platform-bus');
    expect(entry?.DetailType).toBe('inventory.reorder.due');
    const detail = JSON.parse(entry?.Detail ?? '{}') as Record<string, unknown>;
    expect(detail.eventType).toBe('inventory.reorder.due');
    expect(detail.source).toBe('inventory-service');
    expect(detail.correlationId).toBe('trace-1');
    expect(detail.schemaVersion).toBe('1.0');
    expect(detail.payload).toEqual({
      itemId: 'GLOVES-L',
      itemName: 'Gloves (Large)',
      currentQty: 3,
      reorderThreshold: 5,
      deptId: 'NICHOLS',
    });
  });

  it('AC3: skips publish and no-ops when the item was already flagged today (restocked-then-redropped re-run guard)', async () => {
    const ddbSend = vi
      .fn()
      .mockRejectedValue(new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }));
    const ebSend = vi.fn();

    const outcome = await publishReorderDueEvent(
      fakeDdb(ddbSend),
      fakeEb(ebSend),
      env,
      TABLE,
      baseParams,
    );

    expect(outcome).toBe('SkippedDuplicate');
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('logs the original error and rethrows (fail-closed) when EventBridge PutEvents fails, leaving the marker unpublished', async () => {
    const ddbSend = vi.fn().mockResolvedValue({});
    const publishFailure = new Error('EventBridge unavailable');
    const ebSend = vi.fn().mockRejectedValue(publishFailure);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      publishReorderDueEvent(fakeDdb(ddbSend), fakeEb(ebSend), env, TABLE, baseParams),
    ).rejects.toBe(publishFailure);

    expect(ddbSend).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === 'consumableReorderScanner.publish.failed');
    expect(logged?.correlationId).toBe('trace-1');
    errorSpy.mockRestore();
  });

  it('throws (fail-closed) when PLATFORM_EVENT_BUS_NAME is not set', async () => {
    const ddbSend = vi.fn();
    const ebSend = vi.fn();

    await expect(
      publishReorderDueEvent(fakeDdb(ddbSend), fakeEb(ebSend), {}, TABLE, baseParams),
    ).rejects.toThrow('PLATFORM_EVENT_BUS_NAME');
    expect(ddbSend).not.toHaveBeenCalled();
    expect(ebSend).not.toHaveBeenCalled();
  });
});
