import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, type GetCommand } from '@aws-sdk/lib-dynamodb';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { GuardEvent } from '@boxalarm/authz';

const TABLE_NAME = 'alerting-detail-test';
const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

function fakeAuthzClient(): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision.ALLOW }),
  } as unknown as VerifiedPermissionsClient;
}

function buildEvent(dispatchId: string): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/alerting/dispatches/{dispatchId}',
    rawPath: `/api/v1/alerting/dispatches/${dispatchId}`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token-1' },
    pathParameters: { dispatchId },
    requestContext: {
      authorizer: { lambda: { sub: 'member-0012', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' } },
    },
  } as unknown as GuardEvent;
}

describe('alert-detail handler (real DynamoDB, AC2 — pre-plan isolation from the alert-path failure domain)', () => {
  let container: StartedLocalStackContainer;
  let realClient: DynamoDBDocumentClient;

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
    realClient = DynamoDBDocumentClient.from(base);
    process.env.ALERTING_TABLE_NAME = TABLE_NAME;
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'store-1';
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(() => {
    vi.resetModules();
  });

  async function putDispatchAlert(
    dispatchId: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await realClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: buildDeptScopedPk(DEPT_ID, 'DISPATCH', dispatchId),
          sk: 'METADATA',
          entityType: 'DISPATCH_ALERT',
          dispatchId,
          incidentType: 'STRUCTURE_FIRE',
          address: '123 Main St',
          crossStreets: 'Main & Elm',
          narrative: 'Smoke showing, 2nd floor',
          ...extra,
        },
      }),
    );
  }

  it('renders full core content with prePlan null when the DISPATCH_ALERT carries no prePlanRefs yet (E1-S1 gap)', async () => {
    const { createHandler } = await import('./handler.js');
    const dispatchId = 'NICHOLS-preplan-absent';
    await putDispatchAlert(dispatchId);
    const handler = createHandler({ authzClient: fakeAuthzClient(), docClient: realClient });

    const result = await handler(buildEvent(dispatchId));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).toMatchObject({
      incidentType: 'STRUCTURE_FIRE',
      address: '123 Main St',
      crossStreets: 'Main & Elm',
      narrative: 'Smoke showing, 2nd floor',
      prePlan: null,
    });
  });

  it('core-harm: renders full core content with prePlan null when the pre-plan-copy read faults — the fault never propagates to the alert-path response', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createHandler } = await import('./handler.js');
    const dispatchId = 'NICHOLS-preplan-fault';
    await putDispatchAlert(dispatchId, { prePlanRefs: ['OCC-0231'] });

    const faultingClient = {
      send: (command: GetCommand) => {
        const key = (command.input as { Key?: { pk?: string } }).Key;
        if (key?.pk?.includes('PREPLAN')) {
          return Promise.reject(new Error('PRE_PLAN_COPY read fault'));
        }
        return realClient.send(command);
      },
    } as unknown as DynamoDBDocumentClient;
    const handler = createHandler({ authzClient: fakeAuthzClient(), docClient: faultingClient });

    const result = await handler(buildEvent(dispatchId));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).toMatchObject({
      incidentType: 'STRUCTURE_FIRE',
      address: '123 Main St',
      prePlan: null,
    });
    const logged = errorSpy.mock.calls.map((call) => call[0] as string).join('\n');
    expect(logged).toContain('dispatches.detail.preplan_read_failed');
    errorSpy.mockRestore();
  });
});
