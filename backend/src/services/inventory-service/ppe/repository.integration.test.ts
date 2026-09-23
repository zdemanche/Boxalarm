import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  PpeAssignmentConflictError,
  issuePpeAssignment,
  listPpeAssignmentsForMember,
} from './repository.js';

const INVENTORY_TABLE = 'boxalarm-test-ppe-repository-table';
const DEPT_ID = 'NICHOLS';
const deptId = toVerifiedDeptId({ deptId: DEPT_ID });
const config = { tableName: INVENTORY_TABLE };

let container: StartedLocalStackContainer;
let ddbClient: DynamoDBClient;
let documentClient: DynamoDBDocumentClient;

beforeAll(async () => {
  container = await new LocalstackContainer('localstack/localstack:3').start();
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  process.env.AWS_REGION = 'us-east-1';
  ddbClient = new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' });
  await ddbClient.send(
    new CreateTableCommand({
      TableName: INVENTORY_TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
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

describe('issuePpeAssignment against real DynamoDB (LocalStack)', () => {
  const params = {
    deptId,
    memberId: 'MBR-1',
    actorId: 'admin-1',
    correlationId: 'trace-int-1',
    itemType: 'TURNOUT_COAT',
    size: '44R',
    issueDate: '2026-01-10',
    now: new Date('2026-01-10T00:00:00Z'),
  };

  it('writes the PPE_ASSIGNMENT item and audit entry in one transaction, queryable by listPpeAssignmentsForMember', async () => {
    const record = await issuePpeAssignment(documentClient, config, params);

    expect(record.status).toBe('ISSUED');

    const assignments = await listPpeAssignmentsForMember(documentClient, config, {
      deptId,
      memberId: 'MBR-1',
      correlationId: 'trace-int-2',
      now: new Date('2026-01-10T00:00:00Z'),
    });

    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.ppeItemId).toBe('TURNOUT-COAT');
  });

  it('rejects a real conditional-put conflict on re-issue with PpeAssignmentConflictError', async () => {
    await expect(issuePpeAssignment(documentClient, config, params)).rejects.toBeInstanceOf(
      PpeAssignmentConflictError,
    );
  });
});
