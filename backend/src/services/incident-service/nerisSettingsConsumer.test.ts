import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createHandler } from './nerisSettingsConsumer.js';
import { getNerisDeptSettings } from './nerisSettings.js';

interface Sent {
  readonly input: Record<string, unknown>;
}

function sqs(detail: unknown, messageId = 'm-1'): SQSEvent {
  return { Records: [{ messageId, body: JSON.stringify({ detail }) }] } as unknown as SQSEvent;
}

function client(send = vi.fn().mockResolvedValue({})): {
  client: DynamoDBDocumentClient;
  send: ReturnType<typeof vi.fn>;
} {
  return { client: { send } as unknown as DynamoDBDocumentClient, send };
}

beforeEach(() => {
  process.env.INCIDENT_TABLE_NAME = 'incident-table';
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.INCIDENT_TABLE_NAME;
  vi.restoreAllMocks();
});

describe('nerisSettingsConsumer', () => {
  it('projects a NERIS config update into the SETTINGS row, guarded by version', async () => {
    const { client: ddb, send } = client();
    const result = await createHandler({ client: ddb })(
      sqs({
        eventType: 'platform.config.updated',
        payload: {
          deptId: 'NICHOLS',
          configType: 'NERIS',
          version: 3,
          value: { departmentNerisId: 'FD09190828', autoSubmitOnLock: true },
        },
      }),
      {} as never,
      () => undefined,
    );

    expect(result).toEqual({ batchItemFailures: [] });
    const put = (send.mock.calls[0]![0] as Sent).input;
    expect(put.Item).toMatchObject({
      pk: 'DEPT#NICHOLS#NERIS',
      sk: 'SETTINGS',
      departmentNerisId: 'FD09190828',
      autoSubmitOnLock: true,
      submissionsEnabled: true,
      rules: { requireNarrative: true, minNarrativeLength: 0, requireUnitTimes: true },
      version: 3,
    });
    expect(put.ConditionExpression).toBe('attribute_not_exists(pk) OR #version < :version');
  });

  it('ignores other config types without writing', async () => {
    const { client: ddb, send } = client();
    const result = await createHandler({ client: ddb })(
      sqs({
        eventType: 'platform.config.updated',
        payload: { deptId: 'NICHOLS', configType: 'RANKS', version: 1, value: {} },
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toEqual({ batchItemFailures: [] });
    expect(send).not.toHaveBeenCalled();
  });

  it('projects neris.entity.synced unit ids into the ENTITY row', async () => {
    const { client: ddb, send } = client();
    await createHandler({ client: ddb })(
      sqs({
        eventType: 'neris.entity.synced',
        payload: {
          deptId: 'NICHOLS',
          departmentNerisId: 'FD09190828',
          syncedAt: '2026-09-29T10:00:00.000Z',
          units: [{ unitId: 'E1', nerisId: 'FD09190828S001U001', stationId: 'STA1' }, { bad: 1 }],
        },
      }),
      {} as never,
      () => undefined,
    );
    expect((send.mock.calls[0]![0] as Sent).input.Item).toMatchObject({
      sk: 'ENTITY',
      units: [{ unitId: 'E1', nerisId: 'FD09190828S001U001' }],
    });
  });

  it('treats a stale (older version) write as success, and a malformed record as a batch failure', async () => {
    const stale = Object.assign(new Error('stale'), { name: 'ConditionalCheckFailedException' });
    const { client: ddb } = client(vi.fn().mockRejectedValue(stale));
    const handler = createHandler({ client: ddb });
    await expect(
      handler(
        sqs({
          eventType: 'platform.config.updated',
          payload: {
            deptId: 'NICHOLS',
            configType: 'NERIS',
            version: 1,
            value: { departmentNerisId: 'FD09190828' },
          },
        }),
        {} as never,
        () => undefined,
      ),
    ).resolves.toEqual({ batchItemFailures: [] });
    await expect(
      handler(
        sqs({ eventType: 'neris.entity.synced', payload: {} }, 'bad'),
        {} as never,
        () => undefined,
      ),
    ).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: 'bad' }] });
  });
});

describe('getNerisDeptSettings', () => {
  it('merges the SETTINGS and ENTITY rows with defaults', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          sk: 'SETTINGS',
          departmentNerisId: 'FD09190828',
          autoSubmitOnLock: true,
          submissionsEnabled: false,
          rules: { minNarrativeLength: 25 },
        },
        {
          sk: 'ENTITY',
          syncedAt: '2026-09-29T10:00:00.000Z',
          units: [{ unitId: 'E1', nerisId: 'FD09190828S001U001' }],
        },
      ],
    });
    const settings = await getNerisDeptSettings(
      { send } as unknown as DynamoDBDocumentClient,
      'incident-table',
      toVerifiedDeptId({ deptId: 'NICHOLS' }),
    );
    expect(settings).toEqual({
      departmentNerisId: 'FD09190828',
      autoSubmitOnLock: true,
      submissionsEnabled: false,
      rules: { requireNarrative: true, minNarrativeLength: 25, requireUnitTimes: true },
      timeZone: 'America/New_York',
      unitNerisIds: { E1: 'FD09190828S001U001' },
      entitySyncedAt: '2026-09-29T10:00:00.000Z',
    });
  });

  it('returns defaults (no department id) before anything is projected', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const settings = await getNerisDeptSettings(
      { send } as unknown as DynamoDBDocumentClient,
      'incident-table',
      toVerifiedDeptId({ deptId: 'NICHOLS' }),
    );
    expect(settings.departmentNerisId).toBeUndefined();
    expect(settings.autoSubmitOnLock).toBe(false);
    expect(settings.submissionsEnabled).toBe(true);
  });
});
