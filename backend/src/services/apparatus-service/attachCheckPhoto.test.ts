import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { Decision, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'MBR-7',
  deptId: 'NICHOLS',
  'cognito:groups': 'MEMBER',
};

const originalEnv = { ...process.env };
beforeEach(() => {
  // @boxalarm/authz caches its Verified Permissions client per module instance.
  vi.resetModules();
  process.env.PLATFORM_ASSETS_BUCKET_NAME = 'assets-bucket';
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function buildEvent(
  body: unknown,
  params: Record<string, string> = { unitId: 'E1', checkKey: 'check-1-abc' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/apparatus/{unitId}/checks/{checkKey}/photos',
    rawPath: `/api/v1/apparatus/${params.unitId}/checks/${params.checkKey}/photos`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: params,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    requestContext: { authorizer: { lambda: PRINCIPAL } },
  } as unknown as GuardEvent;
}

function authz(decision: 'ALLOW' | 'DENY' = 'ALLOW'): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

function fakeClient(
  options: {
    apparatus?: boolean;
    storedKey?: string;
    uploadedBy?: string;
    createdAt?: number;
  } = {},
) {
  const send = vi.fn((command: unknown) => {
    if (command instanceof QueryCommand) {
      return Promise.resolve(
        options.apparatus === false
          ? { Items: [] }
          : { Items: [{ pk: 'DEPT#NICHOLS#APPARATUS#APP-E1', sk: 'METADATA' }] },
      );
    }
    if (command instanceof TransactWriteCommand && options.storedKey) {
      return Promise.reject(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
        }),
      );
    }
    if (command instanceof GetCommand) {
      return Promise.resolve({
        Item: {
          photoS3Key: options.storedKey,
          uploadedBy: options.uploadedBy ?? 'MBR-7',
          createdAt: options.createdAt ?? 1798050000 - 3600,
        },
      });
    }
    return Promise.resolve({});
  });
  return { client: { send } as unknown as DynamoDBDocumentClient, send };
}

const presign = vi.fn((bucket: string, key: string, _expires: number, contentType: string) =>
  Promise.resolve(`https://${bucket}.s3.amazonaws.com/${key}?ct=${contentType}`),
);

async function handlerWith(client: DynamoDBDocumentClient, decision: 'ALLOW' | 'DENY' = 'ALLOW') {
  const { createAttachCheckPhotoHandler } = await import('./attachCheckPhoto.js');
  return createAttachCheckPhotoHandler({
    client,
    tableName: 'platform',
    now: () => 1798050000,
    presign,
    authzClient: authz(decision),
  });
}

describe('attachCheckPhoto', () => {
  it('returns 403 when Cedar denies AttachCheckPhoto, before touching the table', async () => {
    const { client, send } = fakeClient();
    const result = await (
      await handlerWith(client, 'DENY')
    )(buildEvent({ itemCode: 'TIRES', photo: { filename: 'tires.jpg' } }));
    expect(result).toMatchObject({ statusCode: 403 });
    expect(send).not.toHaveBeenCalled();
  });

  it('records the photo against the run and returns a signed, dept-scoped image upload', async () => {
    const { client, send } = fakeClient();
    const result = await (
      await handlerWith(client)
    )(buildEvent({ itemCode: 'TIRES', photo: { filename: 'tires.jpg' } }));

    expect(result).toMatchObject({ statusCode: 201 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body).toEqual({
      checkKey: 'check-1-abc',
      itemCode: 'TIRES',
      photoS3Key: 'NICHOLS/check/APP-E1/check-1-abc/TIRES/tires.jpg',
      uploadUrl:
        'https://assets-bucket.s3.amazonaws.com/NICHOLS/check/APP-E1/check-1-abc/TIRES/tires.jpg?ct=image/jpeg',
      uploadContentType: 'image/jpeg',
    });
    const transact = send.mock.calls.find(
      (call) => call[0] instanceof TransactWriteCommand,
    )?.[0] as TransactWriteCommand;
    const [photo, audit] = transact.input.TransactItems ?? [];
    expect(photo?.Put?.Item).toMatchObject({
      pk: 'DEPT#NICHOLS#APPARATUS#APP-E1',
      sk: 'CHECK_PHOTO#check-1-abc#TIRES',
      entityType: 'CHECK_PHOTO',
      uploadedBy: 'MBR-7',
    });
    expect(photo?.Put?.ConditionExpression).toBe('attribute_not_exists(sk)');
    expect(audit?.Put?.Item).toMatchObject({
      entityType: 'AUDIT_LOG_ENTRY',
      mutatedEntityType: 'CHECK_PHOTO',
      actorId: 'MBR-7',
    });
  });

  it('a replay re-signs the stored key instead of failing or writing twice', async () => {
    const stored = 'NICHOLS/check/APP-E1/check-1-abc/TIRES/first.jpg';
    const { client } = fakeClient({ storedKey: stored });
    const result = await (
      await handlerWith(client)
    )(buildEvent({ itemCode: 'TIRES', photo: { filename: 'tires.jpg' } }));
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.photoS3Key).toBe(stored);
    expect(body.uploadUrl).toContain(stored);
  });

  it.each([
    [{ itemCode: 'TIRES', photo: { filename: 'page.html' } }, 'photo.filename'],
    [{ itemCode: 'TIRES', photo: { filename: '../x.jpg' } }, 'photo.filename'],
    [{ photo: { filename: 'x.jpg' } }, 'itemCode'],
  ])('rejects %j with a 400 naming %s', async (body, field) => {
    const { client, send } = fakeClient();
    const result = await (await handlerWith(client))(buildEvent(body));
    expect(result).toMatchObject({ statusCode: 400 });
    expect((result as { body: string }).body).toContain(field);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a checkKey that could escape its key segment', async () => {
    const { client } = fakeClient();
    const result = await (
      await handlerWith(client)
    )(
      buildEvent(
        { itemCode: 'TIRES', photo: { filename: 'x.jpg' } },
        { unitId: 'E1', checkKey: '..' },
      ),
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 404 for a unit that is not in the department', async () => {
    const { client } = fakeClient({ apparatus: false });
    const result = await (
      await handlerWith(client)
    )(buildEvent({ itemCode: 'TIRES', photo: { filename: 'x.jpg' } }));
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('keeps a photo whose item code is malformed, under a sanitized key segment', async () => {
    const { client, send } = fakeClient();
    const result = await (
      await handlerWith(client)
    )(buildEvent({ itemCode: 'Brake pressure/PSI', photo: { filename: 'b.jpg' } }));
    expect(result).toMatchObject({ statusCode: 201 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.photoS3Key).toBe('NICHOLS/check/APP-E1/check-1-abc/Brake_pressure_PSI/b.jpg');
    const transact = send.mock.calls.find(
      (call) => call[0] instanceof TransactWriteCommand,
    )?.[0] as TransactWriteCommand;
    expect(transact.input.TransactItems?.[0]?.Put?.Item).toMatchObject({
      sk: 'CHECK_PHOTO#check-1-abc#Brake_pressure_PSI',
      itemCode: 'Brake pressure/PSI',
    });
  });

  it("refuses to re-sign another member's photo, or one past the window, with a 409", async () => {
    const stored = 'NICHOLS/check/APP-E1/check-1-abc/TIRES/first.jpg';
    const body = { itemCode: 'TIRES', photo: { filename: 'tires.jpg' } };

    const other = fakeClient({ storedKey: stored, uploadedBy: 'MBR-OTHER' });
    expect(await (await handlerWith(other.client))(buildEvent(body))).toMatchObject({
      statusCode: 409,
    });

    const old = fakeClient({ storedKey: stored, createdAt: 1798050000 - 8 * 86400 });
    expect(await (await handlerWith(old.client))(buildEvent(body))).toMatchObject({
      statusCode: 409,
    });
  });

  it("lets the apparatus-officer tier re-sign a member's recent photo", async () => {
    const stored = 'NICHOLS/check/APP-E1/check-1-abc/TIRES/first.jpg';
    const { client } = fakeClient({ storedKey: stored, uploadedBy: 'MBR-OTHER' });
    const event = buildEvent({ itemCode: 'TIRES', photo: { filename: 'tires.jpg' } });
    (
      event.requestContext as unknown as { authorizer: { lambda: Record<string, string> } }
    ).authorizer.lambda = { ...PRINCIPAL, 'cognito:groups': 'APPARATUS' };
    expect(await (await handlerWith(client))(event)).toMatchObject({ statusCode: 200 });
  });
});
