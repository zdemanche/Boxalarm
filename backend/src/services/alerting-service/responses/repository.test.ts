import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { recordResponse } from './repository.js';

const TABLE_NAME = 'alerting-responses-test';

describe('recordResponse (real DynamoDB, AC1/AC5/core-harm)', () => {
  let container: StartedLocalStackContainer;
  let client: DynamoDBDocumentClient;

  beforeAll(async () => {
    container = await new LocalstackContainer('localstack/localstack:4').start();
    const base = new DynamoDBClient({
      endpoint: container.getConnectionUri(),
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await base.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    client = DynamoDBDocumentClient.from(base);
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  async function putDispatchAlert(
    dispatchId: string,
    currentToneSequence = 1,
    isTest = false,
  ): Promise<void> {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `DEPT#${deptId}#DISPATCH#${dispatchId}`,
          sk: 'METADATA',
          entityType: 'DISPATCH_ALERT',
          dispatchId,
          deptId,
          currentToneSequence,
          isTest,
        },
      }),
    );
  }

  async function queryOutboxEntriesForDispatch(
    deptId: string,
    dispatchId: string,
  ): Promise<readonly Record<string, unknown>[]> {
    const result = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `DEPT#${deptId}#OUTBOX` },
      }),
    );
    return ((result.Items ?? []) as Record<string, unknown>[]).filter(
      (item) => (item.payload as Record<string, unknown> | undefined)?.dispatchId === dispatchId,
    );
  }

  async function putEligibilitySnapshot(
    memberId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `DEPT#${deptId}#ELIGIBILITY`,
          sk: `MEMBER#${memberId}`,
          entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
          memberId,
          active: true,
          quals: ['INTERIOR', 'DRIVER_OP'],
          roles: ['FIREFIGHTER'],
          availabilityState: 'AVAILABLE',
          snapshotUpdatedAt: 1798000000,
          ...overrides,
        },
      }),
    );
  }

  it('returns dispatch-not-found when the dispatch alert does not exist', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const result = await recordResponse(client, TABLE_NAME, {
      deptId,
      dispatchId: 'NICHOLS-MISSING',
      memberId: 'MBR-0012',
      ackStatus: 'RESPONDING',
      eta: 6,
      assignedApparatusId: null,
      answeredAt: 1798000300,
    });
    expect(result.outcome).toBe('dispatch-not-found');
  });

  it('returns ineligible and writes nothing when the member has no eligibility snapshot (AC3)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const dispatchId = 'NICHOLS-4471-NOSNAP';
    await putDispatchAlert(dispatchId);

    const result = await recordResponse(client, TABLE_NAME, {
      deptId,
      dispatchId,
      memberId: 'MBR-9999',
      ackStatus: 'RESPONDING',
      eta: 6,
      assignedApparatusId: null,
      answeredAt: 1798000300,
    });
    expect(result.outcome).toBe('ineligible');

    const roster = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `DEPT#${deptId}#DISPATCH#${dispatchId}`, sk: 'ROSTER#MBR-9999' },
      }),
    );
    expect(roster.Item).toBeUndefined();
  });

  it('returns ineligible when the eligibility snapshot is inactive (AC3)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const dispatchId = 'NICHOLS-4471-INACTIVE';
    await putDispatchAlert(dispatchId);
    await putEligibilitySnapshot('MBR-0013', { active: false });

    const result = await recordResponse(client, TABLE_NAME, {
      deptId,
      dispatchId,
      memberId: 'MBR-0013',
      ackStatus: 'RESPONDING',
      eta: 6,
      assignedApparatusId: null,
      answeredAt: 1798000300,
    });
    expect(result.outcome).toBe('ineligible');
  });

  it('writes the roster rollup with ackStatus/ackAt/eta and an append-only response record (AC1)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const dispatchId = 'NICHOLS-4471-AC1';
    await putDispatchAlert(dispatchId);
    await putEligibilitySnapshot('MBR-0012');

    const result = await recordResponse(client, TABLE_NAME, {
      deptId,
      dispatchId,
      memberId: 'MBR-0012',
      ackStatus: 'RESPONDING',
      eta: 6,
      assignedApparatusId: 'APP-ENGINE-2',
      answeredAt: 1798000300,
    });
    expect(result.outcome).toBe('recorded');

    const roster = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `DEPT#${deptId}#DISPATCH#${dispatchId}`, sk: 'ROSTER#MBR-0012' },
      }),
    );
    expect(roster.Item).toMatchObject({
      entityType: 'DISPATCH_ROSTER_ENTRY',
      ackStatus: 'RESPONDING',
      ackAt: 1798000300,
      eta: 6,
      assignedApparatusId: 'APP-ENGINE-2',
      lastAnsweredTone: 1,
      quals: ['INTERIOR', 'DRIVER_OP'],
    });

    const responses = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `DEPT#${deptId}#DISPATCH#${dispatchId}`,
          ':prefix': 'RESPONSE#MBR-0012#',
        },
      }),
    );
    expect(responses.Items).toHaveLength(1);
    expect(responses.Items?.[0]).toMatchObject({
      entityType: 'DISPATCH_RESPONSE_RECORD',
      ackStatus: 'RESPONDING',
      toneSequence: 1,
    });
  });

  it('distinguishes DIRECT_TO_SCENE from a station response on the roster rollup (AC5)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const dispatchId = 'NICHOLS-4471-AC5';
    await putDispatchAlert(dispatchId);
    await putEligibilitySnapshot('MBR-0099');

    await recordResponse(client, TABLE_NAME, {
      deptId,
      dispatchId,
      memberId: 'MBR-0099',
      ackStatus: 'DIRECT_TO_SCENE',
      eta: 3,
      assignedApparatusId: null,
      answeredAt: 1798000400,
    });

    const roster = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `DEPT#${deptId}#DISPATCH#${dispatchId}`, sk: 'ROSTER#MBR-0099' },
      }),
    );
    expect(roster.Item?.ackStatus).toBe('DIRECT_TO_SCENE');
  });

  it('does not regress the roster rollup on an out-of-order (older) write, while the response record still lands for the in-order write (core-harm, last-writer-wins)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const dispatchId = 'NICHOLS-4471-RACE';
    await putDispatchAlert(dispatchId);
    await putEligibilitySnapshot('MBR-0012');

    const newer = await recordResponse(client, TABLE_NAME, {
      deptId,
      dispatchId,
      memberId: 'MBR-0012',
      ackStatus: 'RESPONDING',
      eta: 6,
      assignedApparatusId: null,
      answeredAt: 1798000500,
    });
    expect(newer.outcome).toBe('recorded');

    const stale = await recordResponse(client, TABLE_NAME, {
      deptId,
      dispatchId,
      memberId: 'MBR-0012',
      ackStatus: 'NOT_RESPONDING',
      eta: null,
      assignedApparatusId: null,
      answeredAt: 1798000100,
    });
    expect(stale.outcome).toBe('recorded');

    const roster = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `DEPT#${deptId}#DISPATCH#${dispatchId}`, sk: 'ROSTER#MBR-0012' },
      }),
    );
    expect(roster.Item).toMatchObject({ ackStatus: 'RESPONDING', ackAt: 1798000500 });

    const responses = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `DEPT#${deptId}#DISPATCH#${dispatchId}`,
          ':prefix': 'RESPONSE#MBR-0012#',
        },
      }),
    );
    expect(responses.Items).toHaveLength(2);
    const staleRecord = responses.Items?.find((item) => item.answeredAt === 1798000100);
    expect(staleRecord).toMatchObject({
      entityType: 'DISPATCH_RESPONSE_RECORD',
      ackStatus: 'NOT_RESPONDING',
    });
  });

  it('reads currentToneSequence from the dispatch alert and stamps it on the response record', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const dispatchId = 'NICHOLS-4471-TONE2';
    await putDispatchAlert(dispatchId, 2);
    await putEligibilitySnapshot('MBR-0012');

    await recordResponse(client, TABLE_NAME, {
      deptId,
      dispatchId,
      memberId: 'MBR-0012',
      ackStatus: 'NOT_RESPONDING',
      eta: null,
      assignedApparatusId: null,
      answeredAt: 1798000600,
    });

    const roster = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `DEPT#${deptId}#DISPATCH#${dispatchId}`, sk: 'ROSTER#MBR-0012' },
      }),
    );
    expect(roster.Item?.lastAnsweredTone).toBe(2);
  });

  it('writes an alerting.response.confirmed OUTBOX_ENTRY for the platform-bus bridge (chain: alerting -> incident)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const dispatchId = 'NICHOLS-4471-OUTBOX';
    await putDispatchAlert(dispatchId);
    await putEligibilitySnapshot('MBR-0012');

    await recordResponse(client, TABLE_NAME, {
      deptId,
      dispatchId,
      memberId: 'MBR-0012',
      ackStatus: 'RESPONDING',
      eta: 6,
      assignedApparatusId: null,
      answeredAt: 1798000700,
    });

    const entries = await queryOutboxEntriesForDispatch(deptId, dispatchId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entityType: 'OUTBOX_ENTRY',
      eventType: 'alerting.response.confirmed',
      source: 'alerting-service',
      payload: {
        deptId,
        dispatchId,
        memberId: 'MBR-0012',
        status: 'RESPONDING',
        ackAt: 1798000700,
      },
    });
  });

  it('does not bridge a self-test dispatch response onto the platform bus', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const dispatchId = 'NICHOLS-4471-SELFTEST';
    await putDispatchAlert(dispatchId, 1, true);
    await putEligibilitySnapshot('MBR-0012');

    await recordResponse(client, TABLE_NAME, {
      deptId,
      dispatchId,
      memberId: 'MBR-0012',
      ackStatus: 'RESPONDING',
      eta: 6,
      assignedApparatusId: null,
      answeredAt: 1798000800,
    });

    const entries = await queryOutboxEntriesForDispatch(deptId, dispatchId);
    expect(entries).toHaveLength(0);
  });
});
