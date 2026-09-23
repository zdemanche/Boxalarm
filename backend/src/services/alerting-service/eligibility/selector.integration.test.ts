import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { getMemberEligibility } from './selector.js';

const TABLE_NAME = 'alerting-eligibility-test';

describe('getMemberEligibility (real DynamoDB, P3/E1-S8 AC1)', () => {
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

  it('round-trips a real GetCommand keyed on ELIGIBILITY pk / MEMBER#{memberId} sk', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const memberId = `mbr-${randomUUID()}`;

    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `DEPT#${deptId}#ELIGIBILITY`,
          sk: `MEMBER#${memberId}`,
          entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
          memberId,
          active: true,
          quals: ['INTERIOR'],
          roles: ['MEMBER'],
          contactChannels: [{ channel: 'PUSH', token: 'tok-1', platform: 'APNS', valid: true }],
          availabilityState: 'AVAILABLE',
          snapshotUpdatedAt: 1000,
        },
      }),
    );

    const result = await getMemberEligibility(client, TABLE_NAME, deptId, memberId);

    expect(result?.memberId).toBe(memberId);
    expect(result?.availabilityState).toBe('AVAILABLE');
  });

  it('returns undefined for a member with no MEMBER_ELIGIBILITY_SNAPSHOT item in the live table', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

    const result = await getMemberEligibility(
      client,
      TABLE_NAME,
      deptId,
      `mbr-missing-${randomUUID()}`,
    );

    expect(result).toBeUndefined();
  });
});
