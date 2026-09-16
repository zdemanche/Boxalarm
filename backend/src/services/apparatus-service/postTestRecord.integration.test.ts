import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Decision, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';
import { createApparatusRepository } from './apparatusRepository.js';
import { createPostTestRecordHandler } from './postTestRecord.js';
import { createGetTestingSchedulesHandler } from './getTestingSchedules.js';

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

function postEvent(body: string, unitId: string): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/apparatus/{unitId}/tests',
    rawPath: `/api/v1/apparatus/${unitId}/tests`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: { unitId },
    body,
    requestContext: { authorizer: { lambda: PRINCIPAL } },
  } as unknown as GuardEvent;
}

function getEvent(): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/apparatus/testing-schedules',
    rawPath: '/api/v1/apparatus/testing-schedules',
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    queryStringParameters: undefined,
    requestContext: { authorizer: { lambda: PRINCIPAL } },
  } as unknown as GuardEvent;
}

describe('postTestRecord -> getTestingSchedules (real DynamoDB via LocalStack) — proves the write-shape/GSI2-query-shape seam end to end, and that a re-test supersedes rather than duplicates the due entry', () => {
  it('a newly-saved test appears in the due-date listing with the real unitId (not the internal APP- id), and a re-test replaces rather than adds a second entry', async () => {
    const repository = createApparatusRepository(documentClient, TABLE_NAME);
    await repository.createApparatus(DEPT_ID, {
      unitId: 'ENGINE-3',
      type: 'ENGINE',
      status: 'IN_SERVICE',
    });

    const postHandler = createPostTestRecordHandler({
      client: documentClient,
      tableName: TABLE_NAME,
      authzClient: fakeAuthzClient(),
      now: () => '2026-05-01',
    });
    const getHandler = createGetTestingSchedulesHandler({
      client: documentClient,
      tableName: TABLE_NAME,
      authzClient: fakeAuthzClient(),
      now: () => new Date('2026-05-01T00:00:00Z'),
    });

    const firstBody = JSON.stringify({
      testType: 'HOSE',
      result: 'PASS',
      nextDueDate: '2026-10-01',
    });
    const firstPost = await postHandler(postEvent(firstBody, 'ENGINE-3'));
    expect(firstPost).toMatchObject({ statusCode: 201 });

    const firstListing = await getHandler(getEvent());
    const firstSchedule = JSON.parse((firstListing as { body: string }).body) as unknown[];
    expect(firstSchedule).toEqual([{ unitId: 'ENGINE-3', testType: 'HOSE', nextDueDate: '2026-10-01' }]);

    // Re-test early, before the first due date -- must supersede, not accumulate.
    const secondBody = JSON.stringify({
      testType: 'HOSE',
      testDate: '2026-09-20',
      result: 'PASS',
      nextDueDate: '2027-09-20',
    });
    const secondPost = await postHandler(postEvent(secondBody, 'ENGINE-3'));
    expect(secondPost).toMatchObject({ statusCode: 201 });

    const secondListing = await getHandler(getEvent());
    const secondSchedule = JSON.parse((secondListing as { body: string }).body) as unknown[];
    expect(secondSchedule).toEqual([
      { unitId: 'ENGINE-3', testType: 'HOSE', nextDueDate: '2027-09-20' },
    ]);
  });
});
