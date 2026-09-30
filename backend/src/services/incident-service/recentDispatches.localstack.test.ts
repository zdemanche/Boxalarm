import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  getReportsForDispatches,
  putDispatchAlertCopy,
  queryRecentDispatchCopies,
} from './dispatchProjection.js';
import { createIncidentRepository } from './repository.js';

// "Start a report" end to end on a real table: dispatch copies the consumer writes are listed
// newest first from GSI1 without colliding with INCIDENT# rows in the same partition, and a
// report created from a dispatch is found by its dispatchId.
const TABLE_NAME = 'boxalarm-test-incident-recent-dispatches';
const DEPT = toVerifiedDeptId({ deptId: 'dept-001' });
const OTHER = toVerifiedDeptId({ deptId: 'dept-002' });
const NOW = 1_800_000_000;

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
        { AttributeName: 'gsi1pk', AttributeType: 'S' },
        { AttributeName: 'gsi1sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
  client = DynamoDBDocumentClient.from(base);
}, 120_000);

afterAll(async () => {
  await container.stop();
});

function dispatch(deptId: typeof DEPT, dispatchId: string, dispatchedAt: number) {
  return putDispatchAlertCopy(client, TABLE_NAME, {
    dispatchId,
    deptId,
    incidentType: 'MVA',
    address: '5 Church Hill Rd',
    crossStreets: '',
    narrative: 'two cars',
    dispatchedAt,
  });
}

describe('recent dispatches (LocalStack)', () => {
  it('lists this department’s copies newest first within the range, with the report started', async () => {
    await dispatch(DEPT, 'd-old', NOW - 100 * 3600);
    await dispatch(DEPT, 'd-mid', NOW - 40 * 3600);
    await dispatch(DEPT, 'd-new', NOW - 600);
    await dispatch(OTHER, 'd-foreign', NOW - 60);
    // A report in the same GSI1 partition must not show up as a dispatch.
    const repository = createIncidentRepository(client, TABLE_NAME);
    await repository.createIncident(
      DEPT,
      {
        incidentId: 'd-mid',
        dispatchNumber: 'd-mid',
        epochSeconds: NOW - 40 * 3600,
        nerisSchemaVersion: 'v1',
        corePayload: {},
        alarmAt: NOW - 40 * 3600,
        status: 'DRAFT',
        createdBy: 'chief-1',
      },
      NOW,
      'trace-1',
    );

    const recent = await queryRecentDispatchCopies(client, TABLE_NAME, DEPT, {
      fromSeconds: NOW - 72 * 3600,
      toSeconds: NOW,
      limit: 50,
    });
    expect(recent.dispatches.map((d) => d.dispatchId)).toEqual(['d-new', 'd-mid']);

    const older = await queryRecentDispatchCopies(client, TABLE_NAME, DEPT, {
      fromSeconds: 0,
      toSeconds: NOW - 72 * 3600 - 1,
      limit: 50,
    });
    expect(older.dispatches.map((d) => d.dispatchId)).toEqual(['d-old']);

    const reports = await getReportsForDispatches(client, TABLE_NAME, DEPT, ['d-new', 'd-mid']);
    expect(reports.get('d-mid')).toEqual({ incidentId: 'd-mid', status: 'DRAFT' });
    expect(reports.has('d-new')).toBe(false);
  });
});
