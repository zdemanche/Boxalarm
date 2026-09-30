import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent, CedarPrincipalContext } from '@boxalarm/authz';

const SELF: CedarPrincipalContext = {
  sub: 'mbr-1',
  deptId: 'NICHOLS',
  'cognito:groups': 'member',
};

function buildEvent(
  memberId: string | undefined,
  body: string | undefined,
  headers: Record<string, string> | undefined,
  principal: Partial<CedarPrincipalContext> | null | undefined,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/personnel/members/{memberId}',
    rawPath: `/api/v1/personnel/members/${memberId ?? ''}`,
    rawQueryString: '',
    headers,
    pathParameters: memberId ? { memberId } : undefined,
    body,
    requestContext: {
      authorizer: { lambda: principal ?? undefined },
    },
  } as unknown as GuardEvent;
}

function fakeVpClient(decision: 'ALLOW' | 'DENY'): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

function fakeDocClient(docSend: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send: docSend } as unknown as DynamoDBDocumentClient;
}

describe('updateMember handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('advances updatedAt and persists the self-edit (AC1)', async () => {
    const { createHandler } = await import('./updateMember.js');
    const docSend = vi.fn().mockResolvedValue({});
    const wrapped = createHandler({
      client: fakeDocClient(docSend),
      vpClient: fakeVpClient('ALLOW'),
    });

    const result = await wrapped(
      buildEvent(
        'mbr-1',
        JSON.stringify({ phone: '(270) 555-0142' }),
        { authorization: 'Bearer token' },
        SELF,
      ),
    );

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      memberId: string;
      updatedAt: number;
      phone: string;
    };
    expect(body.memberId).toBe('mbr-1');
    // Stored and emitted in E.164 (review MAJOR-3).
    expect(body.phone).toBe('+12705550142');
    expect(typeof body.updatedAt).toBe('number');

    const call = docSend.mock.calls[0]?.[0] as {
      input: {
        TransactItems: Array<{
          Update?: { Key: { pk: string; sk: string } };
          Put?: { Item: { pk: string; sk: string; entityType: string } };
        }>;
      };
    };
    const transactInput = call.input;
    expect(transactInput.TransactItems[0]?.Update?.Key).toEqual({
      pk: 'DEPT#NICHOLS#MEMBER#mbr-1',
      sk: 'METADATA',
    });
    expect(transactInput.TransactItems[1]?.Put?.Item.pk).toBe('DEPT#NICHOLS#OUTBOX#mbr-1');
    expect(transactInput.TransactItems[1]?.Put?.Item.entityType).toBe('OUTBOX_ENTRY');
  });

  it('denies a cross-member edit with 403 before touching DynamoDB (AC2)', async () => {
    const { createHandler } = await import('./updateMember.js');
    const docSend = vi.fn();
    const wrapped = createHandler({
      client: fakeDocClient(docSend),
      vpClient: fakeVpClient('DENY'),
    });

    const result = await wrapped(
      buildEvent(
        'mbr-2',
        JSON.stringify({ phone: '(270) 555-0142' }),
        { authorization: 'Bearer token' },
        SELF,
      ),
    );

    expect(result).toMatchObject({ statusCode: 403 });
    expect(docSend).not.toHaveBeenCalled();
  });

  describe('self-service vs admin edits (MAJ-4, F2.6)', () => {
    // Mirrors the deployed Cedar policies for a MEMBER: SelfUpdateMember is in the
    // every-role self-service policy; UpdateMember stays CHIEF/ADMIN-only.
    function memberVpClient() {
      const send = vi.fn((command: { input: { action: { actionId: string } } }) =>
        Promise.resolve({
          decision:
            command.input.action.actionId === 'SelfUpdateMember' ? Decision.ALLOW : Decision.DENY,
        }),
      );
      return { client: { send } as unknown as VerifiedPermissionsClient, send };
    }

    it('lets a MEMBER update their own profile under SelfUpdateMember', async () => {
      const { createHandler } = await import('./updateMember.js');
      const docSend = vi.fn().mockResolvedValue({});
      const vp = memberVpClient();
      const wrapped = createHandler({ client: fakeDocClient(docSend), vpClient: vp.client });

      const result = await wrapped(
        buildEvent(
          'mbr-1',
          JSON.stringify({ phone: '(270) 555-0142' }),
          { authorization: 'Bearer token' },
          SELF,
        ),
      );

      expect(result).toMatchObject({ statusCode: 200 });
      expect(vp.send.mock.calls[0]?.[0].input.action.actionId).toBe('SelfUpdateMember');
      expect(docSend).toHaveBeenCalledOnce();
    });

    it("403s a MEMBER editing another member's profile (UpdateMember) without touching DynamoDB", async () => {
      const { createHandler } = await import('./updateMember.js');
      const docSend = vi.fn();
      const vp = memberVpClient();
      const wrapped = createHandler({ client: fakeDocClient(docSend), vpClient: vp.client });

      const result = await wrapped(
        buildEvent(
          'mbr-2',
          JSON.stringify({ phone: '(270) 555-0142' }),
          { authorization: 'Bearer token' },
          SELF,
        ),
      );

      expect(result).toMatchObject({ statusCode: 403 });
      expect(vp.send.mock.calls[0]?.[0].input.action.actionId).toBe('UpdateMember');
      expect(docSend).not.toHaveBeenCalled();
    });

    it("lets an admin (UpdateMember ALLOW) edit another member's profile", async () => {
      const { createHandler } = await import('./updateMember.js');
      const docSend = vi.fn().mockResolvedValue({});
      const vp = fakeVpClient('ALLOW');
      const wrapped = createHandler({ client: fakeDocClient(docSend), vpClient: vp });

      const result = await wrapped(
        buildEvent(
          'mbr-2',
          JSON.stringify({ phone: '(270) 555-0142' }),
          { authorization: 'Bearer token' },
          { ...SELF, 'cognito:groups': 'CHIEF' },
        ),
      );

      expect(result).toMatchObject({ statusCode: 200 });
      const vpInput = (vp.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        input: { action: { actionId: string } };
      };
      expect(vpInput.input.action.actionId).toBe('UpdateMember');
    });
  });

  it('returns 503 (fail-closed) and never touches DynamoDB when Verified Permissions is unavailable', async () => {
    const { createHandler } = await import('./updateMember.js');
    const docSend = vi.fn();
    const vpClient = {
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    } as unknown as VerifiedPermissionsClient;
    const wrapped = createHandler({ client: fakeDocClient(docSend), vpClient });

    const result = await wrapped(
      buildEvent(
        'mbr-1',
        JSON.stringify({ phone: '(270) 555-0142' }),
        { authorization: 'Bearer token' },
        SELF,
      ),
    );

    expect(result).toMatchObject({ statusCode: 503 });
    expect(docSend).not.toHaveBeenCalled();
  });

  it('returns 400 for an absent, empty, or malformed body', async () => {
    const { createHandler } = await import('./updateMember.js');
    const docSend = vi.fn();
    const wrapped = createHandler({
      client: fakeDocClient(docSend),
      vpClient: fakeVpClient('ALLOW'),
    });

    const noBody = await wrapped(
      buildEvent('mbr-1', undefined, { authorization: 'Bearer token' }, SELF),
    );
    const emptyBody = await wrapped(
      buildEvent('mbr-1', JSON.stringify({}), { authorization: 'Bearer token' }, SELF),
    );
    const wrongType = await wrapped(
      buildEvent(
        'mbr-1',
        JSON.stringify({ phone: 12345 }),
        { authorization: 'Bearer token' },
        SELF,
      ),
    );
    const malformed = await wrapped(
      buildEvent('mbr-1', '{not-json', { authorization: 'Bearer token' }, SELF),
    );

    expect(noBody).toMatchObject({ statusCode: 400 });
    expect(emptyBody).toMatchObject({ statusCode: 400 });
    expect(wrongType).toMatchObject({ statusCode: 400 });
    expect(malformed).toMatchObject({ statusCode: 400 });
    expect(docSend).not.toHaveBeenCalled();
  });

  it('returns 404 when the MEMBER row does not exist (transaction condition fails)', async () => {
    const { createHandler } = await import('./updateMember.js');
    const docSend = vi.fn().mockRejectedValue(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );
    const wrapped = createHandler({
      client: fakeDocClient(docSend),
      vpClient: fakeVpClient('ALLOW'),
    });

    const result = await wrapped(
      buildEvent(
        'mbr-404',
        JSON.stringify({ phone: '(270) 555-0142' }),
        { authorization: 'Bearer token' },
        { ...SELF, sub: 'mbr-404' },
      ),
    );

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('logs the original error and rethrows on an unexpected DynamoDB failure, emitting a failure metric', async () => {
    const { createHandler } = await import('./updateMember.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const docSend = vi.fn().mockRejectedValue(new Error('table throttled'));
    const wrapped = createHandler({
      client: fakeDocClient(docSend),
      vpClient: fakeVpClient('ALLOW'),
    });

    await expect(
      wrapped(
        buildEvent(
          'mbr-1',
          JSON.stringify({ phone: '(270) 555-0142' }),
          { authorization: 'Bearer token' },
          SELF,
        ),
      ),
    ).rejects.toThrow('table throttled');

    expect(errorSpy).toHaveBeenCalled();
    const loggedError = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as { message: string };
    expect(loggedError.message).toBe('table throttled');
    expect(
      logSpy.mock.calls.some((call) => (call[0] as string).includes('MemberProfileUpdateFailed')),
    ).toBe(true);

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('emits a MemberProfileUpdated business metric on success', async () => {
    const { createHandler } = await import('./updateMember.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const docSend = vi.fn().mockResolvedValue({});
    const wrapped = createHandler({
      client: fakeDocClient(docSend),
      vpClient: fakeVpClient('ALLOW'),
    });

    await wrapped(
      buildEvent(
        'mbr-1',
        JSON.stringify({ phone: '(270) 555-0142' }),
        { authorization: 'Bearer token' },
        SELF,
      ),
    );

    expect(
      logSpy.mock.calls.some((call) => (call[0] as string).includes('MemberProfileUpdated')),
    ).toBe(true);
    logSpy.mockRestore();
  });

  it('exercises the exported handler (entrypoint test) on a pre-AWS-call denial path', async () => {
    const { handler } = await import('./updateMember.js');
    const result = await handler(buildEvent('mbr-1', undefined, undefined, SELF));
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('throws when PLATFORM_TABLE_NAME is unset (misconfigured deployment)', async () => {
    delete process.env.PLATFORM_TABLE_NAME;
    const { createHandler } = await import('./updateMember.js');
    const docSend = vi.fn();
    const wrapped = createHandler({
      client: fakeDocClient(docSend),
      vpClient: fakeVpClient('ALLOW'),
    });

    await expect(
      wrapped(
        buildEvent(
          'mbr-1',
          JSON.stringify({ phone: '(270) 555-0142' }),
          { authorization: 'Bearer token' },
          SELF,
        ),
      ),
    ).rejects.toThrow('PLATFORM_TABLE_NAME is required and was not set');
    expect(docSend).not.toHaveBeenCalled();
  });

  it('rejects a phone it cannot read as a US or international number, with a clear 400 and no write', async () => {
    const { createHandler } = await import('./updateMember.js');
    const docSend = vi.fn().mockResolvedValue({});
    const wrapped = createHandler({
      client: fakeDocClient(docSend),
      vpClient: fakeVpClient('ALLOW'),
    });

    const result = await wrapped(
      buildEvent(
        'mbr-1',
        JSON.stringify({ phone: '555-0100' }),
        { authorization: 'Bearer token' },
        SELF,
      ),
    );

    expect(result).toMatchObject({ statusCode: 400 });
    expect((JSON.parse((result as { body: string }).body) as { detail: string }).detail).toContain(
      '(270) 555-0142',
    );
    expect(docSend).not.toHaveBeenCalled();
  });

  it('emits the normalised E.164 phone on personnel.member.updated', async () => {
    const { createHandler } = await import('./updateMember.js');
    const docSend = vi.fn().mockResolvedValue({});
    const wrapped = createHandler({
      client: fakeDocClient(docSend),
      vpClient: fakeVpClient('ALLOW'),
    });

    await wrapped(
      buildEvent(
        'mbr-1',
        JSON.stringify({ phone: '270.555.0142' }),
        { authorization: 'Bearer token' },
        SELF,
      ),
    );

    const items = (
      docSend.mock.calls[0]?.[0] as {
        input: { TransactItems: Array<{ Put?: { Item: { payload?: { phone?: string } } } }> };
      }
    ).input.TransactItems;
    expect(items.find((item) => item.Put)?.Put?.Item.payload?.phone).toBe('+12705550142');
  });

  // Review MINOR-1: clearing a phone removes it from the row and tells the alerting plane, which
  // removes the member's SMS and voice targets - never keeps paging the old number.
  it('phone: null removes the phone and emits phone: null', async () => {
    const { createHandler } = await import('./updateMember.js');
    const docSend = vi.fn().mockResolvedValue({});
    const wrapped = createHandler({
      client: fakeDocClient(docSend),
      vpClient: fakeVpClient('ALLOW'),
    });

    const result = await wrapped(
      buildEvent('mbr-1', JSON.stringify({ phone: null }), { authorization: 'Bearer token' }, SELF),
    );

    expect(result).toMatchObject({ statusCode: 200 });
    const items = (
      docSend.mock.calls[0]?.[0] as {
        input: {
          TransactItems: Array<{
            Update?: {
              UpdateExpression: string;
              ExpressionAttributeValues: Record<string, unknown>;
            };
            Put?: { Item: { payload?: Record<string, unknown> } };
          }>;
        };
      }
    ).input.TransactItems;
    const update = items.find((item) => item.Update)!.Update!;
    expect(update.UpdateExpression).toMatch(/ REMOVE #phone$/);
    expect(update.ExpressionAttributeValues).not.toHaveProperty(':phone');
    expect(items.find((item) => item.Put)?.Put?.Item.payload).toMatchObject({ phone: null });
  });
});

// Security-web MAJOR 2: the email is the login's recovery address, so a change reaches Cognito
// with the row, and only a chief or admin may make it.
describe('updateMember email changes', () => {
  const originalEnv = { ...process.env };
  const ADMIN: CedarPrincipalContext = {
    sub: 'chief-1',
    deptId: 'NICHOLS',
    'cognito:groups': 'CHIEF',
  };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
    process.env.COGNITO_USER_POOL_ID = 'us-east-1_pool';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  type Command = { constructor: { name: string }; input: Record<string, unknown> };

  function table(
    storedEmail: string | undefined,
    transact: () => Promise<unknown> = () => Promise.resolve({}),
  ) {
    return vi.fn((command: Command) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve(
          storedEmail === undefined ? {} : { Item: { memberId: 'mbr-2', email: storedEmail } },
        );
      }
      return transact();
    });
  }

  function cognito(send = vi.fn().mockResolvedValue({})) {
    return { client: { send } as never, send };
  }

  const attributesOf = (call: unknown[]) =>
    (call[0] as { input: { Username: string; UserAttributes: unknown } }).input;

  async function run(
    memberId: string,
    body: Record<string, unknown>,
    principal: CedarPrincipalContext,
    docSend: ReturnType<typeof vi.fn>,
    cognitoSend: ReturnType<typeof cognito>,
  ) {
    const { createHandler } = await import('./updateMember.js');
    const wrapped = createHandler({
      client: fakeDocClient(docSend),
      vpClient: fakeVpClient('ALLOW'),
      cognito: cognitoSend.client,
    });
    return wrapped(
      buildEvent(memberId, JSON.stringify(body), { authorization: 'Bearer token' }, principal),
    );
  }

  it('a chief changing the email updates Cognito (verified) before the row, and counts it', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const docSend = table('old@example.com');
    const idp = cognito();

    const result = await run('mbr-2', { email: 'new@example.com' }, ADMIN, docSend, idp);

    expect(result).toMatchObject({ statusCode: 200 });
    expect(idp.send).toHaveBeenCalledOnce();
    expect(attributesOf(idp.send.mock.calls[0]!)).toMatchObject({
      UserPoolId: 'us-east-1_pool',
      Username: 'mbr-2',
      UserAttributes: [
        { Name: 'email', Value: 'new@example.com' },
        { Name: 'email_verified', Value: 'true' },
      ],
    });
    expect(docSend.mock.calls.map(([c]) => c.constructor.name)).toEqual([
      'GetCommand',
      'TransactWriteCommand',
    ]);
    expect(logSpy.mock.calls.some(([line]) => String(line).includes('"MemberEmailChanged"'))).toBe(
      true,
    );
    logSpy.mockRestore();
  });

  it('writes nothing when Cognito refuses the change', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const docSend = table('old@example.com');
    const refused = Object.assign(new Error('Invalid email address format.'), {
      name: 'InvalidParameterException',
    });
    const idp = cognito(vi.fn().mockRejectedValue(refused));

    const result = await run('mbr-2', { email: 'not-an-email' }, ADMIN, docSend, idp);

    expect(result).toMatchObject({ statusCode: 400 });
    expect(docSend.mock.calls.map(([c]) => c.constructor.name)).toEqual(['GetCommand']);
    errorSpy.mockRestore();
  });

  it('restores the previous Cognito email when the row write fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const docSend = table('old@example.com', () =>
      Promise.reject(new Error('ThrottlingException')),
    );
    const idp = cognito();

    await expect(run('mbr-2', { email: 'new@example.com' }, ADMIN, docSend, idp)).rejects.toThrow(
      'ThrottlingException',
    );

    expect(idp.send).toHaveBeenCalledTimes(2);
    expect(attributesOf(idp.send.mock.calls[1]!).UserAttributes).toEqual([
      { Name: 'email', Value: 'old@example.com' },
      { Name: 'email_verified', Value: 'true' },
    ]);
    errorSpy.mockRestore();
  });

  it('counts a failed restore so on-call sees the divergence', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const docSend = table('old@example.com', () =>
      Promise.reject(new Error('ThrottlingException')),
    );
    const idp = cognito(
      vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('TooManyRequests')),
    );

    await expect(run('mbr-2', { email: 'new@example.com' }, ADMIN, docSend, idp)).rejects.toThrow(
      'ThrottlingException',
    );

    expect(
      logSpy.mock.calls.some(([line]) => String(line).includes('"MemberEmailCompensationFailed"')),
    ).toBe(true);
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('refuses a member changing their own email with 403, touching neither Cognito nor the row', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const docSend = table('mine@example.com');
    const idp = cognito();

    const result = await run('mbr-1', { email: 'attacker@example.com' }, SELF, docSend, idp);

    expect(result).toMatchObject({ statusCode: 403 });
    expect((JSON.parse((result as { body: string }).body) as { detail: string }).detail).toContain(
      'chief or admin',
    );
    expect(idp.send).not.toHaveBeenCalled();
    expect(docSend.mock.calls.map(([c]) => c.constructor.name)).toEqual(['GetCommand']);
    logSpy.mockRestore();
  });

  it('an own edit that re-sends the unchanged email saves the rest and leaves Cognito alone', async () => {
    const docSend = table('mine@example.com');
    const idp = cognito();

    const result = await run(
      'mbr-1',
      { email: 'mine@example.com', firstName: 'Sam' },
      SELF,
      docSend,
      idp,
    );

    expect(result).toMatchObject({ statusCode: 200 });
    expect(idp.send).not.toHaveBeenCalled();
    const transact = docSend.mock.calls[1]![0];
    const outbox = (transact.input.TransactItems as { Put?: { Item: { payload: object } } }[])[1];
    expect(outbox?.Put?.Item.payload).not.toHaveProperty('email');
  });

  it('404s an email change for a member outside the caller’s department before touching Cognito', async () => {
    const docSend = table(undefined);
    const idp = cognito();

    const result = await run('mbr-other', { email: 'x@example.com' }, ADMIN, docSend, idp);

    expect(result).toMatchObject({ statusCode: 404 });
    expect(idp.send).not.toHaveBeenCalled();
  });
});
