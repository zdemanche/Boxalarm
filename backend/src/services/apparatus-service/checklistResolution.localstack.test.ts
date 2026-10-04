import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { putDepartmentConfig } from '../platform-service/config/repository.js';
import {
  resolveChecklistTemplateForUnit,
  resolveDepartmentDefaultTemplate,
} from './checklistResolution.js';

// The check sheet chain end to end on a real table: the web settings page saves
// CHECKLIST_DEFAULTS through platform-service's repository, and the truck check's
// GET .../checklist reads it back, critical flags included.
const TABLE_NAME = 'boxalarm-test-apparatus-checklist';
const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-001' });
const OTHER_DEPT = toVerifiedDeptId({ deptId: 'dept-002' });

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
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    }),
  );
  client = DynamoDBDocumentClient.from(base);
}, 120_000);

afterAll(async () => {
  await container.stop();
});

describe('check sheet critical flag (LocalStack)', () => {
  it('reads back the default sheet the settings page saved, critical items flagged', async () => {
    await putDepartmentConfig(client, {
      tableName: TABLE_NAME,
      deptId: DEPT_ID,
      configType: 'CHECKLIST_DEFAULTS',
      value: {
        items: [
          { code: 'BRAKES', label: 'Brakes', requiresPhoto: false, critical: true },
          { code: 'LIGHTS', label: 'Lights', requiresPhoto: false },
        ],
      },
      actorId: 'admin-1',
      correlationId: 'trace-1',
    });

    const template = await resolveDepartmentDefaultTemplate(client, TABLE_NAME, DEPT_ID);

    expect(template?.templateId).toBe('department-default-v1');
    expect(template?.items).toEqual([
      { code: 'BRAKES', label: 'Brakes', requiresPhoto: false, critical: true },
      { code: 'LIGHTS', label: 'Lights', requiresPhoto: false, critical: false },
    ]);
    // Another department never sees it.
    await expect(
      resolveDepartmentDefaultTemplate(client, TABLE_NAME, OTHER_DEPT),
    ).resolves.toBeUndefined();
  });

  it('keeps critical on a unit-specific template', async () => {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `DEPT#${DEPT_ID}#CHECKLIST_TEMPLATE#CT-ENGINE`,
          sk: 'METADATA',
          name: 'Engine daily check',
          applicableApparatusIds: ['APP-E1'],
          items: [{ code: 'SCBA', label: 'SCBA pressure', requiresPhoto: false, critical: true }],
        },
      }),
    );

    const template = await resolveChecklistTemplateForUnit(client, TABLE_NAME, DEPT_ID, 'APP-E1');

    expect(template?.items[0]).toMatchObject({ code: 'SCBA', critical: true });
  });
});
