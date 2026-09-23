import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { Decision, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';
import { createApparatusRepository } from './apparatusRepository.js';
import { createPostScbaHandler } from './postScba.js';

const TABLE_NAME = 'boxalarm-test-apparatus-table';
const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-001' });

let container: StartedLocalStackContainer;
let ddbClient: DynamoDBClient;
let documentClient: DynamoDBDocumentClient;

beforeAll(async () => {
  container = await new LocalstackContainer('localstack/localstack:3').start();
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  process.env.AWS_REGION = 'us-east-1';
  process.env.PLATFORM_TABLE_NAME = TABLE_NAME;
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';

  ddbClient = new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' });
  await ddbClient.send(
    new CreateTableCommand({
      TableName: TABLE_NAME,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi2pk', AttributeType: 'S' },
        { AttributeName: 'gsi2sk', AttributeType: 'S' },
        { AttributeName: 'gsi3pk', AttributeType: 'S' },
        { AttributeName: 'gsi3sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI2',
          KeySchema: [
            { AttributeName: 'gsi2pk', KeyType: 'HASH' },
            { AttributeName: 'gsi2sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'GSI3',
          KeySchema: [
            { AttributeName: 'gsi3pk', KeyType: 'HASH' },
            { AttributeName: 'gsi3sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );

  documentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' }),
  );
}, 120_000);

afterAll(async () => {
  ddbClient.destroy();
  await container.stop();
});

function fakeAuthzClient(): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision.ALLOW }),
  } as unknown as VerifiedPermissionsClient;
}

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'member-1',
  deptId: 'dept-001',
  'cognito:groups': 'apparatus',
};

function buildEvent(body: string, unitId: string): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/apparatus/{unitId}/scba',
    rawPath: `/api/v1/apparatus/${unitId}/scba`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: { unitId },
    body,
    requestContext: { authorizer: { lambda: PRINCIPAL } },
  } as unknown as GuardEvent;
}

describe('postScba (real DynamoDB via LocalStack) — proves the GSI3 apparatus-existence lookup and independent GSI2 flow/hydro indexing round-trip (regression coverage for the pk-mismatch and single-gsi2sk bugs)', () => {
  it('finds a real apparatus via GSI3 (not a raw Get on a hand-built key) and independently indexes the flow and hydro due dates under different GSI2 month buckets', async () => {
    const repository = createApparatusRepository(documentClient, TABLE_NAME);
    await repository.createApparatus(DEPT_ID, {
      unitId: 'ENGINE-9',
      type: 'ENGINE',
      status: 'IN_SERVICE',
    });

    const handler = createPostScbaHandler({
      client: documentClient,
      tableName: TABLE_NAME,
      authzClient: fakeAuthzClient(),
    });

    const body = JSON.stringify({
      scbaUnitId: 'SCBA-ENGINE9-A',
      cylinderId: 'CYL-9001',
      flowTestDate: '2026-01-01',
      hydroTestDate: '2026-01-01',
    });
    const result = await handler(buildEvent(body, 'ENGINE-9'));

    expect(result).toMatchObject({ statusCode: 201 });

    // nextFlowTestDue = 2027-01-01 -> GSI2 month bucket 2027-01
    const flowPage = await documentClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI2',
        KeyConditionExpression: 'gsi2pk = :pk',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(DEPT_ID, 'DUE', 'SCBA_TEST', '2027-01'),
        },
      }),
    );
    expect(flowPage.Items).toHaveLength(1);
    expect(flowPage.Items?.[0]?.testType).toBe('SCBA_FLOW');
    expect(flowPage.Items?.[0]?.dueDate).toBe('2027-01-01');

    // nextHydroTestDue = 2030-12-31 -> GSI2 month bucket 2030-12, independently discoverable
    const hydroPage = await documentClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI2',
        KeyConditionExpression: 'gsi2pk = :pk',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(DEPT_ID, 'DUE', 'SCBA_TEST', '2030-12'),
        },
      }),
    );
    expect(hydroPage.Items).toHaveLength(1);
    expect(hydroPage.Items?.[0]?.testType).toBe('SCBA_HYDRO');
    expect(hydroPage.Items?.[0]?.dueDate).toBe('2030-12-31');
  });

  it('returns 404 (not a false-positive match) when the parent apparatus was never registered', async () => {
    const handler = createPostScbaHandler({
      client: documentClient,
      tableName: TABLE_NAME,
      authzClient: fakeAuthzClient(),
    });

    const body = JSON.stringify({
      scbaUnitId: 'SCBA-GHOST-A',
      cylinderId: 'CYL-0000',
      flowTestDate: '2026-01-01',
      hydroTestDate: '2026-01-01',
    });
    const result = await handler(buildEvent(body, 'ENGINE-DOES-NOT-EXIST'));

    expect(result).toMatchObject({ statusCode: 404 });
  });
});
