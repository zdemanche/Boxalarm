import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { buildInspectionKeys } from '../inspectionRecord.js';
import {
  FieldCaptureInspectionNotFoundError,
  FieldCaptureOccupancyNotFoundError,
  submitFieldCapture,
  type SubmitFieldCaptureInput,
} from './repository.js';

const TABLE_NAME = 'boxalarm-test-platform-table';
const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

let container: StartedLocalStackContainer;
let ddbClient: DynamoDBClient;
let doc: DynamoDBDocumentClient;

function sampleInput(overrides: Partial<SubmitFieldCaptureInput> = {}): SubmitFieldCaptureInput {
  return {
    deptId: DEPT_ID,
    occupancyId: 'OCC-1',
    inspectionId: `INS-${Date.now()}`,
    idempotencyKey: `idem-${Date.now()}`,
    violations: [{ code: 'V1', description: 'bad wiring', status: 'open' }],
    photoS3Keys: ['NICHOLS/INSPECTION_RECORD/INS-1/photo.jpg'],
    conductedBy: 'member-1',
    submittedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  };
}

async function seedOccupancy(occupancyId: string): Promise<void> {
  await doc.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `DEPT#NICHOLS#OCCUPANCY#${occupancyId}`,
        sk: 'METADATA',
        entityType: 'OCCUPANCY',
        occupancyId,
      },
    }),
  );
}

async function seedScheduledInspection(occupancyId: string, inspectionId: string): Promise<void> {
  const { pk, sk } = buildInspectionKeys(DEPT_ID, occupancyId, inspectionId);
  await doc.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk,
        sk,
        entityType: 'INSPECTION_RECORD',
        scheduledDate: '2026-09-01',
        violations: [],
        nextDueDate: '2026-09-01',
        gsi2pk: `DEPT#NICHOLS#DUE#INSPECTION_RECORD#2026-09`,
        gsi2sk: `2026-09-01#${inspectionId}`,
      },
    }),
  );
}

beforeAll(async () => {
  container = await new LocalstackContainer('localstack/localstack:3').start();
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  process.env.AWS_REGION = 'us-east-1';
  process.env.AWS_ENDPOINT_URL = container.getConnectionUri();

  ddbClient = new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' });
  await ddbClient.send(
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

  doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' }),
  );

  await seedOccupancy('OCC-1');
}, 120_000);

afterAll(async () => {
  ddbClient.destroy();
  await container.stop();
});

describe('submitFieldCapture (real DynamoDB via LocalStack — offline queue + reconnect + drain, F6.5)', () => {
  it('attaches photoS3Keys to the pre-existing INSPECTION_RECORD on first submit, preserving scheduledDate/nextDueDate', async () => {
    const inspectionId = `INS-${Date.now()}`;
    await seedScheduledInspection('OCC-1', inspectionId);
    const input = sampleInput({ inspectionId });
    const result = await submitFieldCapture(doc, TABLE_NAME, input);
    expect(result.outcome).toBe('created');

    const stored = await doc.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `DEPT#NICHOLS#OCCUPANCY#${input.occupancyId}`,
          sk: `INSPECTION#${input.inspectionId}`,
        },
      }),
    );
    expect(stored.Item?.entityType).toBe('INSPECTION_RECORD');
    expect(stored.Item?.photoS3Keys).toEqual(input.photoS3Keys);
    expect(stored.Item?.violations).toEqual(input.violations);
    expect(stored.Item?.scheduledDate).toBe('2026-09-01');
    expect(stored.Item?.nextDueDate).toBe('2026-09-01');

    const lock = await doc.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `DEPT#NICHOLS#FIELD_CAPTURE_IDEMPOTENCY#${input.idempotencyKey}`, sk: 'LOCK' },
      }),
    );
    expect(lock.Item?.entityType).toBe('FIELD_CAPTURE_IDEMPOTENCY_LOCK');
  });

  it('replays safely — the same idempotencyKey retried after a simulated reconnect double-submits nothing and returns the settled item (AC2 core-harm)', async () => {
    const inspectionId = `INS-replay-${Date.now()}`;
    await seedScheduledInspection('OCC-1', inspectionId);
    const input = sampleInput({ inspectionId });

    const first = await submitFieldCapture(doc, TABLE_NAME, input);
    expect(first.outcome).toBe('created');

    // simulates the mobile outbox retrying the same queued push after connectivity returns
    const retried = await submitFieldCapture(doc, TABLE_NAME, input);
    expect(retried.outcome).toBe('duplicate');
    expect(retried.item.photoS3Keys).toEqual(input.photoS3Keys);

    const items = await doc.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND sk = :sk',
        ExpressionAttributeValues: {
          ':pk': `DEPT#NICHOLS#OCCUPANCY#${input.occupancyId}`,
          ':sk': `INSPECTION#${input.inspectionId}`,
        },
      }),
    );
    expect(items.Items).toHaveLength(1);
    expect(items.Items?.[0]?.photoS3Keys).toEqual(input.photoS3Keys);
  });

  it('a different idempotencyKey against the same inspectionId is not treated as a duplicate — it attaches again (re-conduct), not a conflict', async () => {
    const inspectionId = `INS-conflict-${Date.now()}`;
    await seedScheduledInspection('OCC-1', inspectionId);
    const first = await submitFieldCapture(
      doc,
      TABLE_NAME,
      sampleInput({
        inspectionId,
        idempotencyKey: `idem-a-${Date.now()}`,
        photoS3Keys: ['NICHOLS/INSPECTION_RECORD/INS-1/first.jpg'],
      }),
    );
    expect(first.outcome).toBe('created');

    const second = await submitFieldCapture(
      doc,
      TABLE_NAME,
      sampleInput({
        inspectionId,
        idempotencyKey: `idem-b-${Date.now()}`,
        photoS3Keys: ['NICHOLS/INSPECTION_RECORD/INS-1/second.jpg'],
      }),
    );
    expect(second.outcome).toBe('created');
    expect(second.item.photoS3Keys).toEqual(['NICHOLS/INSPECTION_RECORD/INS-1/second.jpg']);
    expect(second.item.scheduledDate).toBe('2026-09-01');
  });

  it('rejects with FieldCaptureInspectionNotFoundError when no inspection was scheduled to attach to', async () => {
    const inspectionId = `INS-missing-${Date.now()}`;
    await expect(
      submitFieldCapture(doc, TABLE_NAME, sampleInput({ inspectionId })),
    ).rejects.toThrow(FieldCaptureInspectionNotFoundError);
  });

  it('rejects with FieldCaptureOccupancyNotFoundError when the occupancy record does not exist', async () => {
    const occupancyId = `OCC-missing-${Date.now()}`;
    const inspectionId = `INS-${Date.now()}`;
    await seedScheduledInspection(occupancyId, inspectionId);
    await expect(
      submitFieldCapture(doc, TABLE_NAME, sampleInput({ occupancyId, inspectionId })),
    ).rejects.toThrow(FieldCaptureOccupancyNotFoundError);
  });
});
