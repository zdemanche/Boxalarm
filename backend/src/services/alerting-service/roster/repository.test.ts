import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { queryRoster } from './repository.js';

const TABLE_NAME = 'alerting-roster-test';

describe('queryRoster (real DynamoDB, AC2/AC4/AC5)', () => {
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

  it('returns an empty roster when no members have responded yet', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const roster = await queryRoster(client, TABLE_NAME, deptId, 'NICHOLS-EMPTY');
    expect(roster).toEqual([]);
  });

  it('returns quals denormalized on the roster item, never a live personnel-service call (AC4), and distinguishes DIRECT_TO_SCENE (AC5)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const dispatchId = 'NICHOLS-4471-ROSTER';
    const pk = `DEPT#${deptId}#DISPATCH#${dispatchId}`;

    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk,
          sk: 'ROSTER#MBR-0012',
          entityType: 'DISPATCH_ROSTER_ENTRY',
          memberId: 'MBR-0012',
          quals: ['INTERIOR', 'DRIVER_OP'],
          ackStatus: 'RESPONDING',
          ackAt: 1798000300,
          eta: 6,
          assignedApparatusId: 'APP-ENGINE-2',
          lastAnsweredTone: 1,
        },
      }),
    );
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk,
          sk: 'ROSTER#MBR-0099',
          entityType: 'DISPATCH_ROSTER_ENTRY',
          memberId: 'MBR-0099',
          quals: ['EMT'],
          ackStatus: 'DIRECT_TO_SCENE',
          ackAt: 1798000400,
          eta: 3,
          assignedApparatusId: null,
          lastAnsweredTone: 1,
        },
      }),
    );
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { pk, sk: 'METADATA', entityType: 'DISPATCH_ALERT', dispatchId },
      }),
    );

    const roster = await queryRoster(client, TABLE_NAME, deptId, dispatchId);
    expect(roster).toHaveLength(2);
    const byMember = new Map(roster.map((entry) => [entry.memberId, entry]));
    expect(byMember.get('MBR-0012')).toMatchObject({
      quals: ['INTERIOR', 'DRIVER_OP'],
      ackStatus: 'RESPONDING',
    });
    expect(byMember.get('MBR-0099')).toMatchObject({
      ackStatus: 'DIRECT_TO_SCENE',
      quals: ['EMT'],
    });
  });

  it('returns every roster row for a dispatch with many responders (AC2)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const dispatchId = 'NICHOLS-4471-PAGINATED';
    const pk = `DEPT#${deptId}#DISPATCH#${dispatchId}`;
    const memberCount = 30;

    await Promise.all(
      Array.from({ length: memberCount }, (_, i) => {
        const memberId = `MBR-${String(i).padStart(4, '0')}`;
        return client.send(
          new PutCommand({
            TableName: TABLE_NAME,
            Item: {
              pk,
              sk: `ROSTER#${memberId}`,
              entityType: 'DISPATCH_ROSTER_ENTRY',
              memberId,
              quals: [],
              ackStatus: 'RESPONDING',
              ackAt: 1798000000 + i,
              eta: 5,
              assignedApparatusId: null,
              lastAnsweredTone: 1,
            },
          }),
        );
      }),
    );

    const roster = await queryRoster(client, TABLE_NAME, deptId, dispatchId);
    expect(roster).toHaveLength(memberCount);
  });
});
