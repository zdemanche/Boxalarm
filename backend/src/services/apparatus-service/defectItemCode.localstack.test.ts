import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createApparatusRepository } from './apparatusRepository.js';
import { createDefect } from './defectRepository.js';
import { GSI3_INDEX_NAME } from './dynamoClient.js';

// The truck check's duplicate detection reads openDefects[].itemCode back from GET
// apparatus/{unitId}: the defect write and that read, on a real table.
const TABLE_NAME = 'boxalarm-test-apparatus-defect-item';
const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-001' });

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
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi3pk', AttributeType: 'S' },
        { AttributeName: 'gsi3sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: GSI3_INDEX_NAME,
          KeySchema: [
            { AttributeName: 'gsi3pk', KeyType: 'HASH' },
            { AttributeName: 'gsi3sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
  client = DynamoDBDocumentClient.from(base);
  await client.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `DEPT#${DEPT_ID}#APPARATUS#APP-E1`,
        sk: 'METADATA',
        apparatusId: 'APP-E1',
        unitId: 'E1',
        type: 'ENGINE',
        status: 'IN_SERVICE',
        gsi3pk: `DEPT#${DEPT_ID}#APPARATUS`,
        gsi3sk: 'E1',
      },
    }),
  );
}, 120_000);

afterAll(async () => {
  await container.stop();
});

describe('defect itemCode (LocalStack)', () => {
  it('a check-filed defect reads back with its itemCode; a hand-typed one with null', async () => {
    await createDefect(client, TABLE_NAME, {
      deptId: DEPT_ID,
      unitId: 'E1',
      description: 'Failed on the E1 truck check: Brakes.',
      severity: 'MAJOR',
      reportedByMemberId: 'm-1',
      correlationId: 't-1',
      itemCode: 'BRAKES',
      defectId: 'DEF-A',
    });
    await createDefect(client, TABLE_NAME, {
      deptId: DEPT_ID,
      unitId: 'E1',
      description: 'Cracked mirror',
      severity: 'MINOR',
      reportedByMemberId: 'm-1',
      correlationId: 't-2',
      defectId: 'DEF-B',
    });

    const detail = await createApparatusRepository(client, TABLE_NAME).getApparatusDetail(
      DEPT_ID,
      'E1',
    );

    const byId = new Map(detail?.openDefects.map((d) => [d.defectId, d.itemCode]));
    expect(byId.get('DEF-A')).toBe('BRAKES');
    expect(byId.get('DEF-B')).toBeNull();
  });
});
