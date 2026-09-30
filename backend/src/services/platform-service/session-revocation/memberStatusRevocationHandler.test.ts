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
    resolveMemberDeptId: vi.fn().mockResolvedValue('NICHOLS'),
    ...overrides,
  }));
}

let writeRevocationMarker: ReturnType<typeof vi.fn>;

function mockMarker(): void {
  writeRevocationMarker = vi.fn().mockResolvedValue(1_700_000_000);
  vi.doMock('../authorizer/revocationStore.js', () => ({
    writeRevocationMarker: (...args: unknown[]) =>
      writeRevocationMarker(...args) as Promise<number>,
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
    mockMarker();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unmock('./cognitoRevocationClient.js');
    vi.unmock('./memberAccessStore.js');
    vi.unmock('../authorizer/revocationStore.js');
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

  // M1: already-issued access tokens are verified offline; the marker is what stops them.
  it('writes the revocation marker before disabling, keyed on the event deptId', async () => {
    const calls: string[] = [];
    writeRevocationMarker.mockImplementation(() => {
      calls.push('marker');
      return Promise.resolve(1);
    });
    const disableMemberLogin = vi.fn(() => {
      calls.push('disable');
      return Promise.resolve();
    });
    mockCognito({ disableMemberLogin });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const event = {
      ...memberUpdatedEvent('mbr-102', 'RETIRED'),
      payload: { deptId: 'NICHOLS', memberId: 'mbr-102', status: 'RETIRED' },
    };
    await handler({ Records: [sqsRecord(event)] }, {} as never, () => undefined);

    expect(calls).toEqual(['marker', 'disable']);
    expect(writeRevocationMarker).toHaveBeenCalledWith({}, 'platform-table', {
      deptId: 'NICHOLS',
      sub: 'mbr-102',
      reason: 'MEMBER_STATUS',
    });
  });

  it('resolves the department from Cognito for a legacy event without deptId', async () => {
    const resolveMemberDeptId = vi.fn().mockResolvedValue('LEGACY-DEPT');
    mockCognito({ resolveMemberDeptId });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    await handler(
      { Records: [sqsRecord(memberUpdatedEvent('mbr-102', 'LOA'))] },
      {} as never,
      () => undefined,
    );

    expect(writeRevocationMarker).toHaveBeenCalledWith(
      {},
      'platform-table',
      expect.objectContaining({ deptId: 'LEGACY-DEPT', sub: 'mbr-102' }),
    );
  });

  // Security-web MINOR 9: a redriven pre-deptId LOA event must not lock out a member who is
  // ACTIVE today - the department comes from Cognito and the row decides.
  it('re-reads the row for a legacy event without deptId, so a redriven LOA leaves an ACTIVE member enabled', async () => {
    const disableMemberLogin = vi.fn().mockResolvedValue(undefined);
    const enableMemberLogin = vi.fn().mockResolvedValue(undefined);
    const readMemberStatus = vi.fn().mockResolvedValue('ACTIVE');
    mockStore(readMemberStatus);
    mockCognito({
      resolveMemberDeptId: vi.fn().mockResolvedValue('NICHOLS'),
      disableMemberLogin,
      enableMemberLogin,
    });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const result = await handler(
      { Records: [sqsRecord(memberUpdatedEvent('mbr-102', 'LOA'))] },
      {} as never,
      () => undefined,
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(readMemberStatus).toHaveBeenCalledWith({}, 'platform-table', 'NICHOLS', 'mbr-102');
    expect(disableMemberLogin).not.toHaveBeenCalled();
    expect(enableMemberLogin).toHaveBeenCalled();
    expect(writeRevocationMarker).not.toHaveBeenCalled();
  });

  it('writes no marker when the member returns to ACTIVE', async () => {
    mockCognito({});

    const { handler } = await import('./memberStatusRevocationHandler.js');
    await handler(
      { Records: [sqsRecord(memberUpdatedEvent('mbr-102', 'ACTIVE'))] },
      {} as never,
      () => undefined,
    );

    expect(writeRevocationMarker).not.toHaveBeenCalled();
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
    ).resolves.toMatchObject({
      batchItemFailures: [expect.anything()],
    });
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
    ).resolves.toEqual({ batchItemFailures: [] });
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

    await expect(handler(event, {} as never, () => undefined)).resolves.toEqual({
      batchItemFailures: [],
    });
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
    ).resolves.toMatchObject({
      batchItemFailures: [expect.anything()],
    });
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

    await expect(handler(event, {} as never, () => undefined)).resolves.toMatchObject({
      batchItemFailures: [expect.anything()],
    });
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

    await expect(handler(event, {} as never, () => undefined)).resolves.toMatchObject({
      batchItemFailures: [expect.anything()],
    });
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

    await expect(handler(event, {} as never, () => undefined)).resolves.toMatchObject({
      batchItemFailures: [expect.anything()],
    });
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

    await expect(handler(event, {} as never, () => undefined)).resolves.toMatchObject({
      batchItemFailures: [expect.anything()],
    });
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

    await expect(handler(event, {} as never, () => undefined)).resolves.toMatchObject({
      batchItemFailures: [expect.anything()],
    });
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

    await expect(handler(event, {} as never, () => undefined)).resolves.toEqual({
      batchItemFailures: [],
    });
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

    // A config error fails the whole batch: nothing in it can succeed.
    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(
      'COGNITO_USER_POOL_ID is required',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('memberStatusRevocation.configError'),
    );
  });

  // Review minor 15: only failed records are retried, so good ones are not re-applied.
  it('reports only the failed record in the batch response', async () => {
    const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
    mockCognito({ revokeMemberSession });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const result = await handler(
      {
        Records: [
          sqsRecord(memberUpdatedEvent('mbr-bad', ''), 'msg-bad'),
          sqsRecord(memberUpdatedEvent('mbr-200', 'RETIRED'), 'msg-good'),
        ],
      },
      {} as never,
      () => undefined,
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-bad' }] });
    expect(revokeMemberSession).toHaveBeenCalledTimes(1);
  });

  it("retries a member's later records after one of theirs fails, never out of order", async () => {
    const disableMemberLogin = vi
      .fn()
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValue(undefined);
    const enableMemberLogin = vi.fn().mockResolvedValue(undefined);
    mockCognito({ disableMemberLogin, enableMemberLogin });

    const { handler } = await import('./memberStatusRevocationHandler.js');
    const result = await handler(
      {
        Records: [
          sqsRecord(memberUpdatedEvent('mbr-9', 'LOA'), 'msg-1'),
          sqsRecord(memberUpdatedEvent('mbr-9', 'ACTIVE'), 'msg-2'),
        ],
      },
      {} as never,
      () => undefined,
    );

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'msg-1' }, { itemIdentifier: 'msg-2' }],
    });
    expect(enableMemberLogin).not.toHaveBeenCalled();
  });

  // Review of fix/access-control, MAJOR 2: LOA set by mistake and corrected to ACTIVE a
  // moment later must never leave the member disabled in Cognito.
  describe('status race (MAJOR 2)', () => {
    function withDept(memberId: string, status: string): Record<string, unknown> {
      return {
        ...memberUpdatedEvent(memberId, status),
        payload: { deptId: 'NICHOLS', memberId, status },
      };
    }

    function fakeCognito(): { state: () => string; calls: string[] } {
      let loginState = 'enabled';
      const calls: string[] = [];
      mockCognito({
        disableMemberLogin: vi.fn(() => {
          calls.push('disable');
          loginState = 'disabled';
          return Promise.resolve();
        }),
        enableMemberLogin: vi.fn(() => {
          calls.push('enable');
          loginState = 'enabled';
          return Promise.resolve();
        }),
        revokeMemberSession: vi.fn(() => {
          calls.push('signOut');
          return Promise.resolve();
        }),
      });
      return { state: () => loginState, calls };
    }

    const tick = () => new Promise((resolve) => setImmediate(resolve));

    it('interleaved LOA and ACTIVE handlers leave the ACTIVE member enabled', async () => {
      let row = 'LOA';
      mockStore(() => Promise.resolve(row));
      const cognito = fakeCognito();
      // Hold the LOA handler after it has read LOA, until the ACTIVE handler has finished.
      let releaseLoa!: () => void;
      const loaGate = new Promise<void>((resolve) => {
        releaseLoa = resolve;
      });
      writeRevocationMarker.mockImplementation(async () => {
        await loaGate;
        return 1;
      });

      const { handler } = await import('./memberStatusRevocationHandler.js');
      const loa = handler(
        { Records: [sqsRecord(withDept('mbr-9', 'LOA'), 'msg-loa')] },
        {} as never,
        () => undefined,
      );
      for (let i = 0; i < 5; i += 1) await tick();

      row = 'ACTIVE'; // the officer's correction lands
      await handler(
        { Records: [sqsRecord(withDept('mbr-9', 'ACTIVE'), 'msg-active')] },
        {} as never,
        () => undefined,
      );
      expect(cognito.state()).toBe('enabled');

      releaseLoa(); // the stale LOA handler now disables...
      await loa;

      // ...re-reads ACTIVE, and re-enables.
      expect(cognito.calls).toEqual(['enable', 'disable', 'signOut', 'enable']);
      expect(cognito.state()).toBe('enabled');
    });

    it('interleaved ACTIVE and LOA handlers leave the LOA member disabled', async () => {
      let row = 'ACTIVE';
      mockStore(() => Promise.resolve(row));
      let loginState = 'enabled';
      const calls: string[] = [];
      // Hold the ACTIVE handler's enable until the LOA handler has disabled and signed out.
      let releaseActive!: () => void;
      const activeGate = new Promise<void>((resolve) => {
        releaseActive = resolve;
      });
      mockCognito({
        enableMemberLogin: vi.fn(async () => {
          await activeGate;
          calls.push('enable');
          loginState = 'enabled';
        }),
        disableMemberLogin: vi.fn(() => {
          calls.push('disable');
          loginState = 'disabled';
          return Promise.resolve();
        }),
        revokeMemberSession: vi.fn(() => Promise.resolve()),
      });
      const { handler } = await import('./memberStatusRevocationHandler.js');

      const active = handler(
        { Records: [sqsRecord(withDept('mbr-9', 'ACTIVE'), 'msg-active')] },
        {} as never,
        () => undefined,
      );
      for (let i = 0; i < 5; i += 1) await tick();
      row = 'LOA';
      const loa = handler(
        { Records: [sqsRecord(withDept('mbr-9', 'LOA'), 'msg-loa')] },
        {} as never,
        () => undefined,
      );
      for (let i = 0; i < 5; i += 1) await tick();
      expect(loginState).toBe('disabled');

      releaseActive(); // the stale enable lands after the disable...
      await Promise.all([active, loa]);

      // ...and its re-read of LOA disables again.
      expect(calls).toEqual(['disable', 'enable', 'disable']);
      expect(loginState).toBe('disabled');
    });

    it("processes one member's records in arrival order within a batch", async () => {
      // No member row to re-read (a login without a department): order alone decides.
      mockStore(() => Promise.resolve(undefined));
      const cognito = fakeCognito();
      const { handler } = await import('./memberStatusRevocationHandler.js');
      await handler(
        {
          Records: [
            sqsRecord(memberUpdatedEvent('mbr-9', 'LOA'), 'msg-1'),
            sqsRecord(memberUpdatedEvent('mbr-9', 'ACTIVE'), 'msg-2'),
          ],
        },
        {} as never,
        () => undefined,
      );

      expect(cognito.calls).toEqual(['disable', 'signOut', 'enable']);
      expect(cognito.state()).toBe('enabled');
    });

    it('gives up after three rounds of a status that keeps flipping, so SQS retries', async () => {
      let reads = 0;
      mockStore(() => {
        reads += 1;
        return Promise.resolve(reads % 2 === 1 ? 'LOA' : 'ACTIVE');
      });
      fakeCognito();
      const { handler } = await import('./memberStatusRevocationHandler.js');

      await expect(
        handler({ Records: [sqsRecord(withDept('mbr-9', 'LOA'))] }, {} as never, () => undefined),
      ).resolves.toMatchObject({
        batchItemFailures: [expect.anything()],
      });
    });
  });
});
