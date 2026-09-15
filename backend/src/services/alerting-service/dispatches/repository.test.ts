import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createManualDispatch } from './repository.js';
import { deriveIngressIdempotencyKey } from './dispatchIngressPort.js';
import type { DispatchReceived } from './dispatchIngressPort.js';

const TABLE_NAME = 'alerting-dispatches-test';

describe('createManualDispatch (real DynamoDB, AC2/AC4)', () => {
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

  function dispatchPayload(
    externalDispatchId: string,
    sourceSystem: DispatchReceived['sourceSystem'] = 'MANUAL',
  ): DispatchReceived {
    return {
      sourceSystem,
      incidentType: 'STRUCTURE_FIRE',
      address: '123 Main St',
      crossStreets: 'Main & Elm',
      unitsRequested: ['ENGINE-2'],
      narrative: 'Smoke showing',
      externalDispatchId,
    };
  }

  it('creates a DISPATCH_ALERT with sourceSystem MANUAL and sane tone-ladder defaults (AC2)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const externalId = `created-${randomUUID()}`;
    const idempotencyKey = deriveIngressIdempotencyKey(deptId, 'MANUAL', externalId);

    const result = await createManualDispatch(client, TABLE_NAME, {
      deptId,
      dispatch: dispatchPayload(externalId),
      idempotencyKey,
      dispatchedAt: 1798000000,
    });

    expect(result.outcome).toBe('created');
    const dispatchId = result.outcome === 'created' ? result.dispatchId : '';

    const item = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `DEPT#${deptId}#DISPATCH#${dispatchId}`, sk: 'METADATA' },
      }),
    );

    expect(item.Item).toMatchObject({
      entityType: 'DISPATCH_ALERT',
      sourceSystem: 'MANUAL',
      incidentType: 'STRUCTURE_FIRE',
      address: '123 Main St',
      unitsRequested: ['ENGINE-2'],
      toneLadderStatus: 'ACTIVE',
      currentToneSequence: 1,
    });
  });

  it('rejects a duplicate manual submission of the same operator-entered reference — exactly one DISPATCH_ALERT, not two (AC4, core-harm)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const externalId = `dup-${randomUUID()}`;
    const idempotencyKey = deriveIngressIdempotencyKey(deptId, 'MANUAL', externalId);
    const input = {
      deptId,
      dispatch: dispatchPayload(externalId),
      idempotencyKey,
      dispatchedAt: 1798000000,
    };

    const first = await createManualDispatch(client, TABLE_NAME, input);
    expect(first.outcome).toBe('created');

    const second = await createManualDispatch(client, TABLE_NAME, input);
    expect(second.outcome).toBe('duplicate');

    const scan = await client.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'entityType = :entityType AND idempotencyKey = :idempotencyKey',
        ExpressionAttributeValues: {
          ':entityType': 'DISPATCH_ALERT',
          ':idempotencyKey': idempotencyKey,
        },
      }),
    );
    expect(scan.Items).toHaveLength(1);
  });

  it('creates distinct DISPATCH_ALERT items for two different externalDispatchId submissions (survivor coverage)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const externalIdA = `survivor-a-${randomUUID()}`;
    const externalIdB = `survivor-b-${randomUUID()}`;

    const resultA = await createManualDispatch(client, TABLE_NAME, {
      deptId,
      dispatch: dispatchPayload(externalIdA),
      idempotencyKey: deriveIngressIdempotencyKey(deptId, 'MANUAL', externalIdA),
      dispatchedAt: 1798000000,
    });
    const resultB = await createManualDispatch(client, TABLE_NAME, {
      deptId,
      dispatch: dispatchPayload(externalIdB),
      idempotencyKey: deriveIngressIdempotencyKey(deptId, 'MANUAL', externalIdB),
      dispatchedAt: 1798000000,
    });

    expect(resultA.outcome).toBe('created');
    expect(resultB.outcome).toBe('created');
    const dispatchIdA = resultA.outcome === 'created' ? resultA.dispatchId : '';
    const dispatchIdB = resultB.outcome === 'created' ? resultB.dispatchId : '';
    expect(dispatchIdA).not.toBe('');
    expect(dispatchIdB).not.toBe('');
    expect(dispatchIdA).not.toBe(dispatchIdB);
  });

  it('a CAD submission and a MANUAL submission sharing one externalDispatchId both create an alert (P5 — idempotency key must include sourceSystem)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const sharedExternalId = `shared-${randomUUID()}`;

    const manualResult = await createManualDispatch(client, TABLE_NAME, {
      deptId,
      dispatch: dispatchPayload(sharedExternalId, 'MANUAL'),
      idempotencyKey: deriveIngressIdempotencyKey(deptId, 'MANUAL', sharedExternalId),
      dispatchedAt: 1798000000,
    });
    const cadResult = await createManualDispatch(client, TABLE_NAME, {
      deptId,
      dispatch: dispatchPayload(sharedExternalId, 'CAD'),
      idempotencyKey: deriveIngressIdempotencyKey(deptId, 'CAD', sharedExternalId),
      dispatchedAt: 1798000001,
    });

    expect(manualResult.outcome).toBe('created');
    expect(cadResult.outcome).toBe('created');
  });
});
