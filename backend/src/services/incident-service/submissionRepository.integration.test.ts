import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { IncidentNotFoundError } from './repository.js';
import { SubmissionConflictError, createSubmissionRepository } from './submissionRepository.js';

const TABLE_NAME = 'boxalarm-incident-test-table';
const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

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

async function putIncident(incidentId: string, status: string): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: buildDeptScopedPk(DEPT_ID, 'INCIDENT', incidentId),
        sk: 'METADATA',
        entityType: 'INCIDENT',
        incidentId,
        deptId: DEPT_ID,
        status,
      },
    }),
  );
}

describe('submissionRepository (real DynamoDB via LocalStack)', () => {
  it('enqueueSubmission condition-guards on VALIDATED and rejects a non-VALIDATED incident (AC1)', async () => {
    const incidentId = 'NICHOLS-4471-1798000001';
    await putIncident(incidentId, 'DRAFT');
    const repository = createSubmissionRepository(client, TABLE_NAME);

    await expect(
      repository.enqueueSubmission(DEPT_ID, incidentId, 1_798_000_100, 'trace-1'),
    ).rejects.toBeInstanceOf(SubmissionConflictError);
  });

  it('enqueueSubmission rejects a missing incident with IncidentNotFoundError', async () => {
    const repository = createSubmissionRepository(client, TABLE_NAME);

    await expect(
      repository.enqueueSubmission(DEPT_ID, 'NICHOLS-does-not-exist', 1_798_000_100, 'trace-1'),
    ).rejects.toBeInstanceOf(IncidentNotFoundError);
  });

  it('enqueueSubmission transitions VALIDATED to SUBMITTED and appendSubmissionAttempt never overwrites a prior attempt (AC1, AC2)', async () => {
    const incidentId = 'NICHOLS-4471-1798000002';
    await putIncident(incidentId, 'VALIDATED');
    const repository = createSubmissionRepository(client, TABLE_NAME);

    await repository.enqueueSubmission(DEPT_ID, incidentId, 1_798_000_100, 'trace-2');

    const updated = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: buildDeptScopedPk(DEPT_ID, 'INCIDENT', incidentId), sk: 'METADATA' },
      }),
    );
    expect(updated.Item?.status).toBe('SUBMITTED');
    expect(updated.Item?.submissionStatus).toBe('SUBMITTED');

    const first = await repository.appendSubmissionAttempt(
      DEPT_ID,
      incidentId,
      { outcome: 'SUCCESS', httpStatus: 200, retryCount: 0, nerisEnvironment: 'DEV' },
      true,
      1_798_000_200,
    );
    expect(first).toEqual({ submissionStatus: 'ACCEPTED' });

    const afterFirst = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: buildDeptScopedPk(DEPT_ID, 'INCIDENT', incidentId), sk: 'METADATA' },
      }),
    );
    expect(afterFirst.Item?.status).toBe('ACCEPTED');

    const second = await repository.appendSubmissionAttempt(
      DEPT_ID,
      incidentId,
      { outcome: 'RATE_LIMITED', httpStatus: 429, retryCount: 0, nerisEnvironment: 'DEV' },
      false,
      1_798_000_300,
    );
    expect(second).toEqual({ submissionStatus: 'RETRYING' });
  });
});
