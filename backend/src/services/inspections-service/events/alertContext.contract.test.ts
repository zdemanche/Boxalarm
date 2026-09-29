import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { marshall } from '@aws-sdk/util-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';

/**
 * The whole chain pre-plan and hydrant context travels to reach a dispatch, with only the AWS
 * transports faked: the inspections OUTBOX_ENTRY -> DynamoDB Streams NEW_IMAGE -> the platform
 * outbox drain (configured as platform-service/outbox-publisher/handler.ts is) -> EventBridge
 * -> SQS (whole event, no input transformer) -> the alerting copy consumer, which must write
 * the address/geo-indexed copy the dispatch-detail route reads.
 */

interface SentCommand {
  readonly input: Record<string, unknown>;
}

interface TransactItems {
  TransactItems: Array<{
    Put?: { Item: Record<string, unknown> };
    Update?: {
      Key: Record<string, string>;
      UpdateExpression: string;
      ExpressionAttributeValues: Record<string, unknown>;
    };
  }>;
}

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_TABLE_NAME = 'platform-table';
  process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-dev-platform-bus';
  process.env.ALERTING_TABLE_NAME = 'alerting-table';
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  vi.doUnmock('../../alerting-service/eligibility/dynamoClient.js');
});

function outboxItemFrom(send: ReturnType<typeof vi.fn>): Record<string, unknown> {
  for (const call of send.mock.calls) {
    const input = (call[0] as SentCommand).input as Partial<TransactItems>;
    const outbox = input.TransactItems?.find(
      (item) => item.Put?.Item.entityType === 'OUTBOX_ENTRY',
    );
    if (outbox?.Put) return outbox.Put.Item;
  }
  throw new Error('the producer wrote no OUTBOX_ENTRY');
}

async function drainToSqsBody(item: Record<string, unknown>): Promise<string> {
  // Imported after vi.resetModules: the drain caches its clients at module level.
  const { createOutboxDrainHandler } = await import('@boxalarm/outbox');
  const ebSend = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'eb-1' }] });
  const drain = createOutboxDrainHandler('platform-service', {
    eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
    ddbClient: { send: vi.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient,
  });
  await drain(
    {
      Records: [
        {
          eventName: 'INSERT',
          dynamodb: {
            SequenceNumber: '1',
            NewImage: marshall(item, { removeUndefinedValues: true }),
          },
        },
      ],
    } as unknown as DynamoDBStreamEvent,
    {} as never,
    () => undefined,
  );
  expect(ebSend).toHaveBeenCalledOnce();
  const [entry] = (ebSend.mock.calls[0]?.[0] as SentCommand).input.Entries as Array<{
    Source: string;
    DetailType: string;
    Detail: string;
  }>;
  // The alerting rules match on both (infrastructure components/alerting/pre-plan-copies.ts).
  expect(entry?.Source).toBe('inspections-service');
  return JSON.stringify({
    version: '0',
    id: 'eb-1',
    'detail-type': entry?.DetailType,
    source: entry?.Source,
    detail: JSON.parse(entry?.Detail ?? '{}') as unknown,
  });
}

function mockAlertingTable(): ReturnType<typeof vi.fn> {
  const alertingSend = vi.fn().mockResolvedValue({});
  vi.doMock('../../alerting-service/eligibility/dynamoClient.js', () => ({
    createDynamoClient: () => ({ send: alertingSend }),
    readAlertingConfig: () => ({ tableName: 'alerting-table' }),
  }));
  return alertingSend;
}

function copyUpdate(alertingSend: ReturnType<typeof vi.fn>) {
  expect(alertingSend).toHaveBeenCalledOnce();
  const input = (alertingSend.mock.calls[0]?.[0] as SentCommand).input as unknown as TransactItems;
  return input.TransactItems.find((item) => item.Update)?.Update;
}

describe('inspections -> alerting dispatch-context contract', () => {
  it('inspections.preplan.updated lands as an address- and geo-indexed PRE_PLAN_COPY', async () => {
    const producerSend = vi
      .fn()
      .mockResolvedValueOnce({ Items: [] }) // no pre-plan yet
      .mockResolvedValueOnce({
        Item: {
          occupancyId: 'OCC-0231',
          address: '123 Main Street',
          normalizedAddress: '123 MAIN STREET',
          occupancyType: 'MULTI_FAMILY',
          latitude: 41.2429,
          longitude: -73.2007,
        },
      })
      .mockResolvedValueOnce({});
    const { putPrePlan } = await import('../prePlanRepository.js');
    await putPrePlan(
      { send: producerSend } as unknown as DynamoDBDocumentClient,
      'platform-table',
      DEPT_ID,
      'OCC-0231',
      {
        attachmentFilenames: [],
        hazards: ['LPG_TANK_REAR'],
        utilityShutoffs: [{ utility: 'GAS', location: 'rear of building' }],
      },
    );
    const body = await drainToSqsBody(outboxItemFrom(producerSend));

    const alertingSend = mockAlertingTable();
    const { handler } = await import('../../alerting-service/prePlan/prePlanCopyHandler.js');
    await handler({ Records: [{ messageId: 'm-1', body }] } as unknown as SQSEvent);

    const update = copyUpdate(alertingSend);
    expect(update?.Key).toEqual({ pk: 'DEPT#NICHOLS#PREPLAN', sk: 'OCCUPANCY#OCC-0231' });
    expect(update?.ExpressionAttributeValues).toMatchObject({
      ':summary': 'Multi family — 123 Main Street',
      ':hazards': ['LPG_TANK_REAR'],
      ':utilityShutoffs': [{ utility: 'GAS', location: 'rear of building' }],
      ':address': '123 Main Street',
      ':addressKey': '123 MAIN ST',
      ':gsi1pk': 'DEPT#NICHOLS#PREPLAN_ADDR#123 MAIN ST',
      ':latitude': 41.2429,
      ':longitude': -73.2007,
    });
    expect(update?.ExpressionAttributeValues[':gsi2pk']).toMatch(/^DEPT#NICHOLS#PREPLAN_GEO#/);
  });

  it('inspections.hydrant.updated from createHydrant lands as a geo-indexed HYDRANT_COPY', async () => {
    const producerSend = vi.fn().mockResolvedValue({});
    vi.spyOn(DynamoDBDocumentClient, 'from').mockReturnValue({
      send: producerSend,
    } as unknown as DynamoDBDocumentClient);
    const { createHydrant } = await import('../hydrant/hydrantRepository.js');
    await createHydrant(DEPT_ID, {
      hydrantId: 'HYD-0231',
      latitude: 41.2417,
      longitude: -73.2004,
      size: '6-inch',
      flowRatingGpm: 1000,
      nextFlowTestDue: '2027-01-10',
      status: 'IN_SERVICE',
    });
    const body = await drainToSqsBody(outboxItemFrom(producerSend));

    const alertingSend = mockAlertingTable();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('../../alerting-service/prePlan/hydrantCopyHandler.js');
    await handler({ Records: [{ messageId: 'm-1', body }] } as unknown as SQSEvent);

    const update = copyUpdate(alertingSend);
    expect(update?.Key).toEqual({ pk: 'DEPT#NICHOLS#HYDRANT', sk: 'HYDRANT#HYD-0231' });
    expect(update?.ExpressionAttributeValues).toMatchObject({
      ':entityType': 'HYDRANT_COPY',
      ':status': 'IN_SERVICE',
      ':size': '6-inch',
      ':flowRatingGpm': 1000,
      ':latitude': 41.2417,
      ':longitude': -73.2004,
    });
    expect(update?.ExpressionAttributeValues[':gsi2pk']).toMatch(/^DEPT#NICHOLS#HYDRANT_GEO#/);
  });

  it('inspections.hydrant.updated from updateHydrant carries the merged state through to the copy', async () => {
    const producerSend = vi.fn((command: SentCommand) =>
      Promise.resolve(
        'Key' in command.input
          ? {
              Item: {
                hydrantId: 'HYD-0231',
                latitude: 41.2417,
                longitude: -73.2004,
                size: '6-inch',
                flowRatingGpm: 1000,
                status: 'IN_SERVICE',
              },
            }
          : {},
      ),
    );
    vi.spyOn(DynamoDBDocumentClient, 'from').mockReturnValue({
      send: producerSend,
    } as unknown as DynamoDBDocumentClient);
    const { updateHydrant } = await import('../hydrant/hydrantRepository.js');
    await updateHydrant(DEPT_ID, 'HYD-0231', { status: 'OUT_OF_SERVICE' }, 'corr-1');
    const body = await drainToSqsBody(outboxItemFrom(producerSend));

    const alertingSend = mockAlertingTable();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('../../alerting-service/prePlan/hydrantCopyHandler.js');
    await handler({ Records: [{ messageId: 'm-1', body }] } as unknown as SQSEvent);

    expect(copyUpdate(alertingSend)?.ExpressionAttributeValues).toMatchObject({
      ':status': 'OUT_OF_SERVICE',
      ':size': '6-inch',
      ':latitude': 41.2417,
    });
  });

  it('an occupancy archive tombstones the alerting PRE_PLAN_COPY (index keys removed)', async () => {
    const producerSend = vi.fn((command: SentCommand) =>
      Promise.resolve(
        'Key' in command.input && !('TransactItems' in command.input)
          ? { Item: { occupancyId: 'OCC-0231', normalizedAddress: '12 MAIN ST' } }
          : {},
      ),
    );
    const { archiveOccupancy } = await import('../archive/archiveRepository.js');
    await archiveOccupancy(
      { send: producerSend } as unknown as DynamoDBDocumentClient,
      'platform-table',
      DEPT_ID,
      'OCC-0231',
      'chief-1',
    );
    const body = await drainToSqsBody(outboxItemFrom(producerSend));

    const alertingSend = mockAlertingTable();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('../../alerting-service/prePlan/prePlanCopyHandler.js');
    await handler({ Records: [{ messageId: 'm-1', body }] } as unknown as SQSEvent);

    const update = copyUpdate(alertingSend);
    expect(update?.Key).toEqual({ pk: 'DEPT#NICHOLS#PREPLAN', sk: 'OCCUPANCY#OCC-0231' });
    expect(update?.UpdateExpression).toContain('REMOVE gsi1pk, gsi1sk, gsi2pk, gsi2sk');
  });
});
