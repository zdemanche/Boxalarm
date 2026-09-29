import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserNotFoundException } from '@aws-sdk/client-cognito-identity-provider';
import type { SQSEvent, SQSRecord } from 'aws-lambda';

function sqsRecord(body: unknown, messageId = 'msg-1'): SQSRecord {
  return { body: JSON.stringify(body), messageId } as SQSRecord;
}

function memberUpdatedEvent(memberId: string, status: string): Record<string, unknown> {
  return {
    eventId: 'evt-1',
    eventTime: '2026-09-14T00:00:00Z',
    eventType: 'personnel.member.updated',
    source: 'personnel-service',
    correlationId: 'corr-1',
    schemaVersion: '1.0',
    payload: { memberId, status },
  };
}

// Every test gets working defaults for the login-state calls and the member-status read;
// a test overrides only what it is about.
function mockCognito(overrides: Record<string, unknown>): void {
  vi.doMock('./cognitoRevocationClient.js', () => ({
    readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
    createRevocationClient: () => ({}),
    revokeMemberSession: vi.fn().mockResolvedValue(undefined),
    disableMemberLogin: vi.fn().mockResolvedValue(undefined),
    enableMemberLogin: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }));
}

function mockStore(readMemberStatus: (...args: unknown[]) => Promise<string | undefined>): void {
  vi.doMock('./memberAccessStore.js', () => ({
    readPlatformTableName: () => 'platform-table',
    getAccessStoreClient: () => ({}),
    readMemberStatus,
  }));
}

describe('memberStatusRevocationHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.COGNITO_USER_POOL_ID = 'pool-1';
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
    mockStore(() => Promise.resolve(undefined));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unmock('./cognitoRevocationClient.js');
    vi.unmock('./memberAccessStore.js');
    vi.restoreAllMocks();
  });

  it('sends the Cognito revocation command for a LOA transition (entrypoint, core-harm)', async () => {
    const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
    mockCognito({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const event: SQSEvent = { Records: [sqsRecord(memberUpdatedEvent('mbr-102', 'LOA'))] };
    await handler(event, {} as never, () => undefined);

    expect(revokeMemberSession).toHaveBeenCalledWith(
      {},
      { userPoolId: 'pool-1', username: 'mbr-102', correlationId: 'corr-1' },
    );
  });

  it('sends the Cognito revocation command for a RETIRED transition', async () => {
    const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
    mockCognito({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const event: SQSEvent = { Records: [sqsRecord(memberUpdatedEvent('mbr-200', 'RETIRED'))] };
    await handler(event, {} as never, () => undefined);

    expect(revokeMemberSession).toHaveBeenCalledWith(
      {},
      { userPoolId: 'pool-1', username: 'mbr-200', correlationId: 'corr-1' },
    );
  });

  it('unwraps an EventBridge-shaped body (payload nested under detail) before parsing', async () => {
    const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
    mockCognito({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const eventBridgeWrapped = {
      version: '0',
      id: 'eb-evt-1',
      'detail-type': 'personnel.member.updated',
      source: 'personnel-service',
      time: '2026-09-14T00:00:00Z',
      detail: memberUpdatedEvent('mbr-eb-1', 'LOA'),
    };
    const event: SQSEvent = { Records: [sqsRecord(eventBridgeWrapped)] };
    await handler(event, {} as never, () => undefined);

    expect(revokeMemberSession).toHaveBeenCalledWith(
      {},
      { userPoolId: 'pool-1', username: 'mbr-eb-1', correlationId: 'corr-1' },
    );
  });

  it('re-enables the login and revokes nothing when the member returns to ACTIVE', async () => {
    const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
    const disableMemberLogin = vi.fn().mockResolvedValue(undefined);
    const enableMemberLogin = vi.fn().mockResolvedValue(undefined);
    mockCognito({ revokeMemberSession, disableMemberLogin, enableMemberLogin });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const event: SQSEvent = { Records: [sqsRecord(memberUpdatedEvent('mbr-102', 'ACTIVE'))] };
    await handler(event, {} as never, () => undefined);

    expect(enableMemberLogin).toHaveBeenCalledWith(
      {},
      { userPoolId: 'pool-1', username: 'mbr-102', correlationId: 'corr-1' },
    );
    expect(revokeMemberSession).not.toHaveBeenCalled();
    expect(disableMemberLogin).not.toHaveBeenCalled();
  });

  // C1: a global sign-out alone let the member sign straight back in with the same password.
  it('disables the login BEFORE signing out on LOA, so no sign-in or refresh can re-mint a session', async () => {
    const calls: string[] = [];
    const disableMemberLogin = vi.fn(() => {
      calls.push('disable');
      return Promise.resolve();
    });
    const revokeMemberSession = vi.fn(() => {
      calls.push('signOut');
      return Promise.resolve();
    });
    mockCognito({ disableMemberLogin, revokeMemberSession });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    await handler(
      { Records: [sqsRecord(memberUpdatedEvent('mbr-102', 'LOA'))] },
      {} as never,
      () => undefined,
    );

    expect(calls).toEqual(['disable', 'signOut']);
    expect(disableMemberLogin).toHaveBeenCalledWith(
      {},
      { userPoolId: 'pool-1', username: 'mbr-102', correlationId: 'corr-1' },
    );
  });

  it('acts on the member row, not the event: a stale LOA event for a member now ACTIVE re-enables instead of disabling', async () => {
    const readMemberStatus = vi.fn().mockResolvedValue('ACTIVE');
    mockStore(readMemberStatus);
    const disableMemberLogin = vi.fn().mockResolvedValue(undefined);
    const enableMemberLogin = vi.fn().mockResolvedValue(undefined);
    const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
    mockCognito({ disableMemberLogin, enableMemberLogin, revokeMemberSession });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const stale = {
      ...memberUpdatedEvent('mbr-102', 'LOA'),
      payload: { deptId: 'NICHOLS', memberId: 'mbr-102', status: 'LOA' },
    };
    await handler({ Records: [sqsRecord(stale)] }, {} as never, () => undefined);

    expect(readMemberStatus).toHaveBeenCalledWith({}, 'platform-table', 'NICHOLS', 'mbr-102');
    expect(enableMemberLogin).toHaveBeenCalled();
    expect(disableMemberLogin).not.toHaveBeenCalled();
    expect(revokeMemberSession).not.toHaveBeenCalled();
  });

  it('acts on the member row: a stale ACTIVE event for a member now RETIRED still disables and signs out', async () => {
    mockStore(vi.fn().mockResolvedValue('RETIRED'));
    const disableMemberLogin = vi.fn().mockResolvedValue(undefined);
    const enableMemberLogin = vi.fn().mockResolvedValue(undefined);
    const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
    mockCognito({ disableMemberLogin, enableMemberLogin, revokeMemberSession });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const stale = {
      ...memberUpdatedEvent('mbr-102', 'ACTIVE'),
      payload: { deptId: 'NICHOLS', memberId: 'mbr-102', status: 'ACTIVE' },
    };
    await handler({ Records: [sqsRecord(stale)] }, {} as never, () => undefined);

    expect(disableMemberLogin).toHaveBeenCalled();
    expect(revokeMemberSession).toHaveBeenCalled();
    expect(enableMemberLogin).not.toHaveBeenCalled();
  });

  it('rethrows when the member row cannot be read, so SQS retries instead of guessing', async () => {
    mockStore(vi.fn().mockRejectedValue(new Error('dynamo down')));
    const disableMemberLogin = vi.fn();
    const enableMemberLogin = vi.fn();
    mockCognito({ disableMemberLogin, enableMemberLogin });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const event = {
      ...memberUpdatedEvent('mbr-102', 'LOA'),
      payload: { deptId: 'NICHOLS', memberId: 'mbr-102', status: 'LOA' },
    };
    await expect(
      handler({ Records: [sqsRecord(event)] }, {} as never, () => undefined),
    ).rejects.toThrow('dynamo down');
    expect(disableMemberLogin).not.toHaveBeenCalled();
    expect(enableMemberLogin).not.toHaveBeenCalled();
  });

  it('no-ops when disabling finds no such Cognito user, instead of DLQing', async () => {
    const revokeMemberSession = vi.fn();
    mockCognito({
      disableMemberLogin: vi
        .fn()
        .mockRejectedValue(new UserNotFoundException({ message: 'gone', $metadata: {} })),
      revokeMemberSession,
    });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    await expect(
      handler(
        { Records: [sqsRecord(memberUpdatedEvent('mbr-ghost', 'RETIRED'))] },
        {} as never,
        () => undefined,
      ),
    ).resolves.toBeUndefined();
    expect(revokeMemberSession).not.toHaveBeenCalled();
  });

  it('leaves other members untouched — only the event own memberId is ever passed as Username (survivor)', async () => {
    const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
    mockCognito({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const event: SQSEvent = {
      Records: [
        sqsRecord(memberUpdatedEvent('mbr-777', 'LOA'), 'msg-1'),
        sqsRecord(memberUpdatedEvent('mbr-active-1', 'ACTIVE'), 'msg-2'),
      ],
    };
    await handler(event, {} as never, () => undefined);

    expect(revokeMemberSession).toHaveBeenCalledTimes(1);
    expect(revokeMemberSession).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ username: 'mbr-777' }),
    );
  });

  it('ignores a member.updated with no status (a profile, push-token or role change) instead of DLQing it', async () => {
    const revokeMemberSession = vi.fn();
    mockCognito({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const rolesChange = {
      ...memberUpdatedEvent('mbr-102', 'LOA'),
      payload: { deptId: 'NICHOLS', memberId: 'mbr-102', roles: ['MEMBER', 'OFFICER'] },
    };
    const event: SQSEvent = { Records: [sqsRecord(rolesChange)] };

    await expect(handler(event, {} as never, () => undefined)).resolves.toBeUndefined();
    expect(revokeMemberSession).not.toHaveBeenCalled();
  });

  // Events emitted before updateMemberStatus also wrote `status` carry only newStatus; a
  // redrive of those from the DLQ must still end the sessions (member-roles review MINOR-6).
  it('revokes on a newStatus-only LOA event (emitted before status was added)', async () => {
    const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
    mockCognito({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const legacy = {
      ...memberUpdatedEvent('mbr-102', 'LOA'),
      payload: {
        deptId: 'NICHOLS',
        memberId: 'mbr-102',
        previousStatus: 'ACTIVE',
        newStatus: 'LOA',
      },
    };
    await handler({ Records: [sqsRecord(legacy)] }, {} as never, () => undefined);

    expect(revokeMemberSession).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ username: 'mbr-102' }),
    );
  });

  // Review MINOR-7: the "not a status change" skip must not swallow a garbage payload.
  it('still DLQs a payload with neither memberId nor status', async () => {
    const revokeMemberSession = vi.fn();
    mockCognito({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const garbage = { ...memberUpdatedEvent('mbr-102', 'LOA'), payload: { deptId: 'NICHOLS' } };

    await expect(
      handler({ Records: [sqsRecord(garbage)] }, {} as never, () => undefined),
    ).rejects.toThrow('payload.memberId is required');
  });

  it('rethrows (never swallows) on malformed payload — empty status — so SQS retries and the DLQ catches it', async () => {
    const revokeMemberSession = vi.fn();
    mockCognito({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const malformed = memberUpdatedEvent('mbr-102', ' ');
    const event: SQSEvent = { Records: [sqsRecord(malformed)] };

    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(
      'payload.status is required',
    );
    expect(revokeMemberSession).not.toHaveBeenCalled();
  });

  it('rethrows on malformed payload — whitespace-only memberId', async () => {
    const revokeMemberSession = vi.fn();
    mockCognito({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const malformed = memberUpdatedEvent('   ', 'LOA');
    const event: SQSEvent = { Records: [sqsRecord(malformed)] };

    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(
      'payload.memberId is required',
    );
  });

  it('rethrows when a record has the wrong eventType for this queue', async () => {
    const revokeMemberSession = vi.fn();
    mockCognito({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const wrongEvent = {
      ...memberUpdatedEvent('mbr-102', 'LOA'),
      eventType: 'personnel.member.created',
    };
    const event: SQSEvent = { Records: [sqsRecord(wrongEvent)] };

    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(
      'unexpected eventType',
    );
    expect(revokeMemberSession).not.toHaveBeenCalled();
  });

  it('still revokes the valid record in a batch even when an earlier record is malformed', async () => {
    const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
    mockCognito({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const malformed = memberUpdatedEvent('mbr-bad', '');
    const event: SQSEvent = {
      Records: [
        sqsRecord(malformed, 'msg-bad'),
        sqsRecord(memberUpdatedEvent('mbr-200', 'RETIRED'), 'msg-good'),
      ],
    };

    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(
      'payload.status is required',
    );
    expect(revokeMemberSession).toHaveBeenCalledWith(
      {},
      { userPoolId: 'pool-1', username: 'mbr-200', correlationId: 'corr-1' },
    );
  });

  it('rethrows when Cognito is unavailable, never swallowing, so SQS visibility-timeout retry can do its job', async () => {
    const revokeMemberSession = vi.fn().mockRejectedValue(new Error('Cognito unreachable'));
    mockCognito({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const event: SQSEvent = { Records: [sqsRecord(memberUpdatedEvent('mbr-102', 'LOA'))] };

    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(
      'Cognito unreachable',
    );
  });

  it('no-ops (logged, non-retryable) when the member is unknown to Cognito, avoiding a DLQ storm', async () => {
    const revokeMemberSession = vi
      .fn()
      .mockRejectedValue(new UserNotFoundException({ message: 'no such user', $metadata: {} }));
    mockCognito({
      readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
      createRevocationClient: () => ({}),
      revokeMemberSession,
    });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const event: SQSEvent = { Records: [sqsRecord(memberUpdatedEvent('mbr-ghost', 'LOA'))] };

    await expect(handler(event, {} as never, () => undefined)).resolves.toBeUndefined();
  });

  it('logs and rethrows when the revocation config is missing (e.g. COGNITO_USER_POOL_ID unset)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockCognito({
      readRevocationConfig: () => {
        throw new Error('COGNITO_USER_POOL_ID is required and was not set');
      },
      createRevocationClient: () => ({}),
      revokeMemberSession: vi.fn(),
    });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const event: SQSEvent = { Records: [sqsRecord(memberUpdatedEvent('mbr-102', 'LOA'))] };

    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(
      'COGNITO_USER_POOL_ID is required',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('memberStatusRevocation.configError'),
    );
  });
});
