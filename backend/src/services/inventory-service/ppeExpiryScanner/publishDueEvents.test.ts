import { describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutEventsCommand, type EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { publishDueEvent } from './publishDueEvents.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const env = {
  PLATFORM_TABLE_NAME: 'platform-service',
  PLATFORM_EVENT_BUS_NAME: 'boxalarm-test-platform-bus',
};

function fakeDdb(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

function fakeEb(send: ReturnType<typeof vi.fn>): EventBridgeClient {
  return { send } as unknown as EventBridgeClient;
}

const baseParams = {
  deptId,
  memberId: 'MBR-0034',
  ppeItemId: 'TURNOUT-COAT',
  expiryDate: '2026-10-14',
  correlationId: 'trace-1',
  now: new Date('2026-09-14T12:00:00Z'),
};

describe('publishDueEvent (AC2)', () => {
  it('writes the dedup marker, publishes exactly one ppe.expiry.due event, then marks it published', async () => {
    const ddbSend = vi.fn().mockResolvedValue({});
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'evt-1' }] });

    const outcome = await publishDueEvent(fakeDdb(ddbSend), fakeEb(ebSend), env, baseParams);

    expect(outcome).toBe('Published');
    expect(ddbSend).toHaveBeenCalledTimes(2);
    const putCommand = ddbSend.mock.calls[0]?.[0] as PutCommand;
    expect(putCommand).toBeInstanceOf(PutCommand);
    expect(putCommand.input.Item?.pk).toBe('DEPT#NICHOLS#PPE_EXPIRY_FLAG#2026-09-14');
    expect(putCommand.input.Item?.sk).toBe('PPE#TURNOUT-COAT');

    const updateCommand = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCommand).toBeInstanceOf(UpdateCommand);
    expect(updateCommand.input.ConditionExpression).toBe('attribute_exists(pk)');

    expect(ebSend).toHaveBeenCalledTimes(1);
    const putEvents = ebSend.mock.calls[0]?.[0] as PutEventsCommand;
    const entry = putEvents.input.Entries?.[0];
    expect(entry?.EventBusName).toBe('boxalarm-test-platform-bus');
    expect(entry?.DetailType).toBe('ppe.expiry.due');
    const detail = JSON.parse(entry?.Detail ?? '{}') as Record<string, unknown>;
    expect(detail.eventType).toBe('ppe.expiry.due');
    expect(detail.source).toBe('inventory-service');
    expect(detail.payload).toEqual({
      memberId: 'MBR-0034',
      ppeItemId: 'TURNOUT-COAT',
      expiryDate: '2026-10-14',
    });
  });

  it('skips publish and no-ops when the same-day dedup marker already exists (AC2 re-run guard)', async () => {
    const ddbSend = vi
      .fn()
      .mockRejectedValue(new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }));
    const ebSend = vi.fn();

    const outcome = await publishDueEvent(fakeDdb(ddbSend), fakeEb(ebSend), env, baseParams);

    expect(outcome).toBe('SkippedDuplicate');
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('logs and rethrows when the EventBridge send throws', async () => {
    const ddbSend = vi.fn().mockResolvedValue({});
    const publishFailure = new Error('EventBridge unavailable');
    const ebSend = vi.fn().mockRejectedValue(publishFailure);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      publishDueEvent(fakeDdb(ddbSend), fakeEb(ebSend), env, baseParams),
    ).rejects.toBe(publishFailure);

    const logged = errorSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === 'ppeExpiryScanner.publish.failed');
    expect(logged?.correlationId).toBe('trace-1');
    errorSpy.mockRestore();
  });

  it('logs and rethrows on a per-entry PutEvents failure', async () => {
    const ddbSend = vi.fn().mockResolvedValue({});
    const ebSend = vi
      .fn()
      .mockResolvedValue({ Entries: [{ ErrorCode: 'InternalFailure', ErrorMessage: 'boom' }] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      publishDueEvent(fakeDdb(ddbSend), fakeEb(ebSend), env, baseParams),
    ).rejects.toThrow('boom');
    errorSpy.mockRestore();
  });

  it('throws (fail-closed) when PLATFORM_EVENT_BUS_NAME is not set', async () => {
    const ddbSend = vi.fn();
    const ebSend = vi.fn();

    await expect(
      publishDueEvent(
        fakeDdb(ddbSend),
        fakeEb(ebSend),
        { PLATFORM_TABLE_NAME: 'platform-service' },
        baseParams,
      ),
    ).rejects.toThrow('PLATFORM_EVENT_BUS_NAME');
    expect(ddbSend).not.toHaveBeenCalled();
    expect(ebSend).not.toHaveBeenCalled();
  });
});
