import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  Decision,
  IsAuthorizedWithTokenCommand,
  VerifiedPermissionsClient,
} from '@aws-sdk/client-verifiedpermissions';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';
import { handler, updateHydrantInner } from './updateHydrantHandler.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const vpMock = mockClient(VerifiedPermissionsClient);

const validPrincipal: CedarPrincipalContext = {
  sub: 'mbr-102',
  deptId: 'NICHOLS',
  'cognito:groups': 'OFFICER',
};

function buildEvent(overrides: {
  body?: string;
  pathParameters?: Record<string, string>;
  authorizer?: Partial<CedarPrincipalContext>;
  authorization?: string;
}): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/inspections/hydrants/{hydrantId}',
    rawPath: '/api/v1/inspections/hydrants/HYD-0231',
    rawQueryString: '',
    headers: overrides.authorization ? { authorization: overrides.authorization } : {},
    isBase64Encoded: false,
    body: overrides.body,
    pathParameters: overrides.pathParameters ?? { hydrantId: 'HYD-0231' },
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'api.boxalarm.dev',
      domainPrefix: 'api',
      http: {
        method: 'PUT',
        path: '/api/v1/inspections/hydrants/HYD-0231',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'req-1',
      routeKey: 'PUT /api/v1/inspections/hydrants/{hydrantId}',
      stage: '$default',
      time: '03/Sep/2026:00:00:00 +0000',
      timeEpoch: Date.now(),
      authorizer: { lambda: overrides.authorizer },
    },
  } as unknown as GuardEvent;
}

beforeEach(() => {
  ddbMock.reset();
  vpMock.reset();
  process.env.PLATFORM_TABLE_NAME = 'boxalarm-platform-table';
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-test';
});

// Business logic (validation, persistence, error mapping) tested directly against the
// inner handler, independent of Cedar authorization mechanics — see createHydrantHandler
// for why, and packages/authz's own guard.test.ts for the wrapper's own coverage.
describe('updateHydrantInner (business logic, AC2/AC3)', () => {
  it('records a flow test and marks out-of-service, returning the untransformed status (AC2, AC3)', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: 'DEPT#NICHOLS#HYDRANT#HYD-0231',
        sk: 'METADATA',
        status: 'OUT_OF_SERVICE',
        lastFlowTestDate: '2026-09-01',
      },
    });
    const body = JSON.stringify({ status: 'OUT_OF_SERVICE', lastFlowTestDate: '2026-09-01' });
    const result = (await updateHydrantInner(buildEvent({ body }), validPrincipal)) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(200);
    const persisted = JSON.parse(result.body) as { status: string };
    expect(persisted.status).toBe('OUT_OF_SERVICE');
  });

  it('emits the inspections.hydrant.updated outbox event transactionally with the item update (AC2)', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: { status: 'OUT_OF_SERVICE' } });
    const body = JSON.stringify({ status: 'OUT_OF_SERVICE' });
    await updateHydrantInner(buildEvent({ body }), validPrincipal);
    const call = ddbMock.commandCalls(TransactWriteCommand)[0];
    const outboxItem = call?.args[0].input.TransactItems?.[1]?.Put?.Item;
    expect(outboxItem?.eventType).toBe('inspections.hydrant.updated');
    expect(outboxItem?.source).toBe('inspections-service');
  });

  it('rejects an absent body with 400 RFC7807', async () => {
    const result = (await updateHydrantInner(buildEvent({}), validPrincipal)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
  });

  it('rejects a nextFlowTestDue that precedes lastFlowTestDate with 400 RFC7807', async () => {
    const body = JSON.stringify({ lastFlowTestDate: '2027-01-10', nextFlowTestDue: '2026-06-01' });
    const result = (await updateHydrantInner(buildEvent({ body }), validPrincipal)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
  });

  it('rejects a shape-valid but calendar-invalid nextFlowTestDue with 400', async () => {
    const body = JSON.stringify({ nextFlowTestDue: '2027-02-30' });
    const result = (await updateHydrantInner(buildEvent({ body }), validPrincipal)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
  });

  it('rejects a hydrantId path parameter containing "#" with 400 rather than a 503 misclassified as a DynamoDB outage', async () => {
    const body = JSON.stringify({ status: 'OUT_OF_SERVICE' });
    const result = (await updateHydrantInner(
      buildEvent({ body, pathParameters: { hydrantId: 'HYD#1' } }),
      validPrincipal,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('returns 404 when the hydrant does not exist (attribute_exists(pk) condition fails)', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );
    const body = JSON.stringify({ status: 'OUT_OF_SERVICE' });
    const result = (await updateHydrantInner(buildEvent({ body }), validPrincipal)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(404);
  });

  it('fails closed with 503 when DynamoDB is unavailable (never a defaulted success)', async () => {
    ddbMock.on(TransactWriteCommand).rejects(new Error('simulated outage'));
    const body = JSON.stringify({ status: 'OUT_OF_SERVICE' });
    const result = (await updateHydrantInner(buildEvent({ body }), validPrincipal)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(503);
  });

  it('returns 404, not a 200 with stale data, when the post-transaction consistent read finds nothing (P2/P5 regression)', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(GetCommand).resolves({});
    const body = JSON.stringify({ status: 'OUT_OF_SERVICE' });
    const result = (await updateHydrantInner(buildEvent({ body }), validPrincipal)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(404);
  });
});

// The exported, Cedar-wrapped `handler` — see createHydrantHandler.test.ts for why this
// closes the review's persistent P8/V2-r1 finding (any authenticated member could mark a
// hydrant out of service) now that E8-S3's Cedar authorization is merged.
describe('handler (Cedar-authorized entrypoint)', () => {
  it('denies with 403 and never reaches the repository when Cedar denies the caller', async () => {
    vpMock.on(IsAuthorizedWithTokenCommand).resolves({ decision: Decision.DENY });
    const body = JSON.stringify({ status: 'OUT_OF_SERVICE' });
    const result = (await handler(
      buildEvent({ body, authorizer: validPrincipal, authorization: 'Bearer member-token' }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(403);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('fails closed with 503, not a silent allow, when Verified Permissions is unavailable', async () => {
    vpMock.on(IsAuthorizedWithTokenCommand).rejects(new Error('VP outage'));
    const body = JSON.stringify({ status: 'OUT_OF_SERVICE' });
    const result = (await handler(
      buildEvent({ body, authorizer: validPrincipal, authorization: 'Bearer officer-token' }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(503);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('updates a hydrant (200) when Cedar allows the caller', async () => {
    vpMock.on(IsAuthorizedWithTokenCommand).resolves({ decision: Decision.ALLOW });
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: { status: 'OUT_OF_SERVICE' } });
    const body = JSON.stringify({ status: 'OUT_OF_SERVICE' });
    const result = (await handler(
      buildEvent({ body, authorizer: validPrincipal, authorization: 'Bearer officer-token' }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(200);
  });
});
