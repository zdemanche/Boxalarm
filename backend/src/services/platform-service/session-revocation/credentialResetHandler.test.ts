import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InvalidParameterException,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const ADMIN: CedarPrincipalContext = {
  sub: 'admin-1',
  deptId: 'NICHOLS',
  'cognito:groups': 'ADMIN',
};

type Inner = (
  e: GuardEvent,
  p: CedarPrincipalContext,
) => Promise<{ statusCode: number; body: string }>;

function buildEvent(body: unknown): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/platform/sessions/reset-credentials',
    headers: { authorization: 'Bearer token' },
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: { authorizer: { lambda: ADMIN } },
  } as unknown as GuardEvent;
}

interface Mocks {
  resolveMemberDeptId: ReturnType<typeof vi.fn>;
  resetMemberPassword: ReturnType<typeof vi.fn>;
  revokeMemberSession: ReturnType<typeof vi.fn>;
}

function mockDeps(overrides: Partial<Mocks> = {}): Mocks {
  const mocks: Mocks = {
    resolveMemberDeptId: vi.fn().mockResolvedValue('NICHOLS'),
    resetMemberPassword: vi.fn().mockResolvedValue(undefined),
    revokeMemberSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  vi.doMock('./cognitoRevocationClient.js', () => ({
    readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
    createRevocationClient: () => ({}),
    ...mocks,
  }));
  vi.doMock('@boxalarm/authz', async () => {
    const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
    return { ...actual, withAuthorization: (inner: unknown) => inner };
  });
  vi.doMock('./memberAccessStore.js', () => ({
    readPlatformTableName: () => 'platform-table',
    getAccessStoreClient: () => ({}),
  }));
  vi.doMock('../authorizer/revocationStore.js', () => ({
    writeRevocationMarker: (...args: unknown[]) =>
      writeRevocationMarker(...args) as Promise<number>,
  }));
  return mocks;
}

let writeRevocationMarker: ReturnType<typeof vi.fn>;

async function load(): Promise<Inner> {
  const { handler } = await import('./credentialResetHandler.js');
  return handler as unknown as Inner;
}

describe('credentialResetHandler', () => {
  beforeEach(() => {
    vi.resetModules();
    writeRevocationMarker = vi.fn().mockResolvedValue(1_700_000_000);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.doUnmock('./cognitoRevocationClient.js');
    vi.doUnmock('@boxalarm/authz');
    vi.doUnmock('./memberAccessStore.js');
    vi.doUnmock('../authorizer/revocationStore.js');
    vi.restoreAllMocks();
  });

  it('marks the member revoked (M1) so already-issued access tokens stop working', async () => {
    mockDeps();
    const handler = await load();

    await handler(buildEvent({ memberId: 'sub-9' }), ADMIN);

    expect(writeRevocationMarker).toHaveBeenCalledWith({}, 'platform-table', {
      deptId: 'NICHOLS',
      sub: 'sub-9',
      reason: 'CREDENTIAL_RESET',
      actorId: 'admin-1',
    });
  });

  it('answers 503 and changes nothing in Cognito when the marker cannot be written', async () => {
    const mocks = mockDeps();
    writeRevocationMarker.mockRejectedValue(new Error('dynamo down'));
    const handler = await load();

    expect((await handler(buildEvent({ memberId: 'sub-9' }), ADMIN)).statusCode).toBe(503);
    expect(mocks.resetMemberPassword).not.toHaveBeenCalled();
  });

  it('resets the password BEFORE signing out, so the old password cannot mint a surviving session', async () => {
    const order: string[] = [];
    const mocks = mockDeps({
      resetMemberPassword: vi.fn(() => {
        order.push('reset');
        return Promise.resolve();
      }),
      revokeMemberSession: vi.fn(() => {
        order.push('signOut');
        return Promise.resolve();
      }),
    });
    const handler = await load();

    const result = await handler(buildEvent({ memberId: 'sub-9' }), ADMIN);

    expect(result.statusCode).toBe(202);
    expect(order).toEqual(['reset', 'signOut']);
    expect(mocks.resetMemberPassword).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ userPoolId: 'pool-1', username: 'sub-9' }),
    );
  });

  it('refuses a member in another department without touching Cognito state (F9.6)', async () => {
    const mocks = mockDeps({ resolveMemberDeptId: vi.fn().mockResolvedValue('OTHER') });
    const handler = await load();

    const result = await handler(buildEvent({ memberId: 'sub-9' }), ADMIN);

    expect(result.statusCode).toBe(403);
    expect(mocks.resetMemberPassword).not.toHaveBeenCalled();
    expect(mocks.revokeMemberSession).not.toHaveBeenCalled();
  });

  it('fails closed when the target has no department attribute', async () => {
    const mocks = mockDeps({ resolveMemberDeptId: vi.fn().mockResolvedValue(undefined) });
    const handler = await load();

    expect((await handler(buildEvent({ memberId: 'sub-9' }), ADMIN)).statusCode).toBe(403);
    expect(mocks.resetMemberPassword).not.toHaveBeenCalled();
  });

  it('answers 400 without a memberId', async () => {
    mockDeps();
    const handler = await load();

    expect((await handler(buildEvent({}), ADMIN)).statusCode).toBe(400);
  });

  it('answers 404 for an unknown member', async () => {
    mockDeps({
      resolveMemberDeptId: vi
        .fn()
        .mockRejectedValue(new UserNotFoundException({ message: 'x', $metadata: {} })),
    });
    const handler = await load();

    expect((await handler(buildEvent({ memberId: 'ghost' }), ADMIN)).statusCode).toBe(404);
  });

  it('still signs every session out when the reset cannot be sent, and says so with a 409', async () => {
    const mocks = mockDeps({
      resetMemberPassword: vi
        .fn()
        .mockRejectedValue(
          new InvalidParameterException({ message: 'no verified', $metadata: {} }),
        ),
    });
    const handler = await load();

    const result = await handler(buildEvent({ memberId: 'sub-9' }), ADMIN);

    expect(result.statusCode).toBe(409);
    expect((JSON.parse(result.body) as { detail: string }).detail).toContain(
      'InvalidParameterException',
    );
    expect(mocks.revokeMemberSession).toHaveBeenCalled();
  });

  it('answers 503 when the sign-out fails', async () => {
    mockDeps({ revokeMemberSession: vi.fn().mockRejectedValue(new Error('throttled')) });
    const handler = await load();

    expect((await handler(buildEvent({ memberId: 'sub-9' }), ADMIN)).statusCode).toBe(503);
  });
});

describe('credentialResetHandler Cedar wiring', () => {
  it('is gated by the ResetMemberCredentials action and alarms on every invocation', async () => {
    vi.resetModules();
    const withAuthorization = vi.fn((inner: unknown) => inner);
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization };
    });

    await import('./credentialResetHandler.js');

    expect(withAuthorization).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        actionType: 'Boxalarm::Action',
        actionId: 'ResetMemberCredentials',
        resourceType: 'Boxalarm::Member',
        alarmOnInvocation: 'ResetMemberCredentialsInvoked',
      }),
    );
    vi.doUnmock('@boxalarm/authz');
  });
});
