import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { EventBridgeClient, PutEventsRequestEntry } from '@aws-sdk/client-eventbridge';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';

/**
 * Design review M1, producer -> transport -> consumer -> readers:
 *   PUT /platform/config ALERT_RULES (putDepartmentConfig: config row + outbox row)
 *     -> the deployed platform outbox drain -> platform.config.updated on the bus
 *     -> the alerting-owned consumer -> ALERT_RULES_COPY in the alerting table
 *     -> what the tone ladder and the voice escalation actually read.
 * Before, nothing wrote the copy: every ladder ran on the defaults (75 s / 180 s / 360 s, one
 * responder, no quals) while the settings page showed the chief's rules.
 */

const DEPT = toVerifiedDeptId({ deptId: 'NICHOLS' });

interface Item {
  pk: string;
  sk: string;
  [key: string]: unknown;
}

/** An alerting table: Get and the copy's version-guarded Put. */
function alertingTable() {
  const items = new Map<string, Item>();
  const send = vi.fn(
    (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const input = command.input;
      if (command.constructor.name === 'GetCommand') {
        const key = input.Key as { pk: string; sk: string };
        return Promise.resolve({ Item: items.get(`${key.pk}#${key.sk}`) });
      }
      if (command.constructor.name === 'PutCommand') {
        const item = input.Item as Item;
        const existing = items.get(`${item.pk}#${item.sk}`);
        const version = (input.ExpressionAttributeValues as Record<string, number>)[':version']!;
        if (existing && !((existing.sourceVersion as number) < version)) {
          return Promise.reject(
            new ConditionalCheckFailedException({ message: 'x', $metadata: {} }),
          );
        }
        items.set(`${item.pk}#${item.sk}`, item);
        return Promise.resolve({});
      }
      return Promise.reject(new Error(`alerting table fake: ${command.constructor.name}`));
    },
  );
  return { client: { send } as unknown as DynamoDBDocumentClient, items };
}

/** Runs the real putDepartmentConfig and the real drain; returns the bus entry. */
async function publishConfig(
  value: Record<string, unknown>,
  expectedVersion?: number,
): Promise<PutEventsRequestEntry> {
  const platformWrites: { input: { TransactItems: { Put: { Item: Item } }[] } }[] = [];
  const platform = {
    send: vi.fn((command: { input: { TransactItems: { Put: { Item: Item } }[] } }) => {
      platformWrites.push(command);
      return Promise.resolve({});
    }),
  } as unknown as DynamoDBDocumentClient;
  const { putDepartmentConfig } = await import('../../platform-service/config/repository.js');
  await putDepartmentConfig(platform, {
    tableName: 'platform',
    deptId: DEPT,
    configType: 'ALERT_RULES',
    value,
    actorId: 'chief-1',
    correlationId: 'req-1',
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  });
  const outbox = platformWrites[0]!.input.TransactItems.map((t) => t.Put.Item).find(
    (item) => item.entityType === 'OUTBOX_ENTRY',
  )!;

  const entries: PutEventsRequestEntry[] = [];
  // The drain caches its clients per module instance: a fresh instance per publish.
  vi.resetModules();
  const { createOutboxDrainHandler } = await import('@boxalarm/outbox');
  const drain = createOutboxDrainHandler('platform-service', {
    eventBridgeClient: {
      send: vi.fn((command: { input: { Entries: PutEventsRequestEntry[] } }) => {
        entries.push(...command.input.Entries);
        return Promise.resolve({ Entries: command.input.Entries.map(() => ({ EventId: 'e' })) });
      }),
    } as unknown as EventBridgeClient,
    ddbClient: { send: vi.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient,
  });
  await drain(
    {
      Records: [
        {
          eventName: 'INSERT',
          dynamodb: {
            SequenceNumber: '1',
            NewImage: marshall(outbox, { removeUndefinedValues: true }),
          },
        },
      ],
    } as unknown as DynamoDBStreamEvent,
    {} as never,
    () => undefined,
  );
  return entries[0]!;
}

function sqs(entry: PutEventsRequestEntry): SQSEvent {
  return {
    Records: [
      {
        messageId: 'm-1',
        body: JSON.stringify({
          source: entry.Source,
          'detail-type': entry.DetailType,
          detail: JSON.parse(entry.Detail!) as unknown,
        }),
      },
    ],
  } as unknown as SQSEvent;
}

describe('M1: department ALERT_RULES reach the ladder the alerting plane runs', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
    process.env.PLATFORM_TABLE_NAME = 'platform';
    process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-dev-platform-bus';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("the chief's rules become the tone timing, the stopping predicate and the voice threshold", async () => {
    const table = alertingTable();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../eligibility/dynamoClient.js')>()),
      createDynamoClient: () => table.client,
    }));

    const entry = await publishConfig({
      escalationThresholdN: 90,
      toneLadder: { tone2AtSeconds: 120, tone3AtSeconds: 300 },
      defaultRule: { minResponders: 3, requiredQuals: ['INTERIOR'] },
    });
    expect(entry).toMatchObject({
      Source: 'platform-service',
      DetailType: 'platform.config.updated',
    });

    const { handler } = await import('./alertRulesCopyHandler.js');
    expect(await handler(sqs(entry))).toEqual({ batchItemFailures: [] });

    const { readDepartmentToneConfig } = await import('../escalation/toneLadder.js');
    const { readEscalationThresholdSeconds } = await import('../escalation/scheduleEscalation.js');
    expect(await readDepartmentToneConfig(table.client, 'alerting-table', DEPT)).toEqual({
      tone2AtSeconds: 120,
      tone3AtSeconds: 300,
      minResponders: 3,
      requiredQuals: ['INTERIOR'],
    });
    expect(await readEscalationThresholdSeconds(table.client, 'alerting-table', DEPT)).toBe(90);
  });

  it('a newer version replaces the copy whole (removed fields fall back to defaults); an older one never wins', async () => {
    const table = alertingTable();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../eligibility/dynamoClient.js')>()),
      createDynamoClient: () => table.client,
    }));
    const { handler } = await import('./alertRulesCopyHandler.js');

    const v1 = await publishConfig({ defaultRule: { minResponders: 4 } });
    const v2 = await publishConfig({ toneLadder: { tone2AtSeconds: 150 } }, 1);
    await handler(sqs(v2));
    await handler(sqs(v1)); // out of order: stale

    const { readDepartmentToneConfig } = await import('../escalation/toneLadder.js');
    expect(await readDepartmentToneConfig(table.client, 'alerting-table', DEPT)).toEqual({
      tone2AtSeconds: 150,
      tone3AtSeconds: 360,
      minResponders: 1,
      requiredQuals: [],
    });
  });

  it('acknowledges other config types without writing', async () => {
    const table = alertingTable();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../eligibility/dynamoClient.js')>()),
      createDynamoClient: () => table.client,
    }));
    const { handler } = await import('./alertRulesCopyHandler.js');
    const body = JSON.stringify({
      detail: {
        eventType: 'platform.config.updated',
        eventTime: new Date().toISOString(),
        payload: { deptId: 'NICHOLS', configType: 'NERIS', version: 1, value: {} },
      },
    });

    expect(await handler({ Records: [{ messageId: 'm', body }] } as unknown as SQSEvent)).toEqual({
      batchItemFailures: [],
    });
    expect(table.items.size).toBe(0);
  });

  it('reports a malformed ALERT_RULES event as a batch failure (retried, then dead-lettered)', async () => {
    const table = alertingTable();
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../eligibility/dynamoClient.js')>()),
      createDynamoClient: () => table.client,
    }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./alertRulesCopyHandler.js');
    const body = JSON.stringify({
      detail: {
        eventType: 'platform.config.updated',
        payload: { deptId: 'NICHOLS', configType: 'ALERT_RULES', value: {} },
      },
    });

    expect(await handler({ Records: [{ messageId: 'bad', body }] } as unknown as SQSEvent)).toEqual(
      {
        batchItemFailures: [{ itemIdentifier: 'bad' }],
      },
    );
  });
});
