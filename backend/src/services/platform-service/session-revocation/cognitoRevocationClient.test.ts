import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AdminGetUserCommand,
  AdminUserGlobalSignOutCommand,
  TooManyRequestsException,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import {
  createRevocationClient,
  readRevocationConfig,
  resolveMemberDeptId,
  revokeMemberSession,
} from './cognitoRevocationClient.js';

function fakeClient(send: (command: unknown) => Promise<unknown>): CognitoIdentityProviderClient {
  return { send } as unknown as CognitoIdentityProviderClient;
}

describe('readRevocationConfig', () => {
  it('reads COGNITO_USER_POOL_ID', () => {
    expect(readRevocationConfig({ COGNITO_USER_POOL_ID: 'pool-1' })).toEqual({
      userPoolId: 'pool-1',
    });
  });

  it('throws (fail-closed) when COGNITO_USER_POOL_ID is missing (empty/absent-input row)', () => {
    expect(() => readRevocationConfig({})).toThrow('COGNITO_USER_POOL_ID is required');
  });
});

describe('createRevocationClient', () => {
  it('returns the sdkClientOverride when supplied (test seam)', () => {
    const override = fakeClient(() => Promise.resolve({}));
    expect(createRevocationClient(override)).toBe(override);
  });
});

describe('revokeMemberSession', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends AdminUserGlobalSignOutCommand for the given userPoolId/username and emits a success metric (core-harm)', async () => {
    const sent: unknown[] = [];
    const client = fakeClient((command) => {
      sent.push(command);
      return Promise.resolve({});
    });

    await revokeMemberSession(client, { userPoolId: 'pool-1', username: 'mbr-102' });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(AdminUserGlobalSignOutCommand);
    expect((sent[0] as AdminUserGlobalSignOutCommand).input).toEqual({
      UserPoolId: 'pool-1',
      Username: 'mbr-102',
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('RevocationSucceeded'));
  });

  it('succeeds idempotently on a redelivered event / re-trigger for an already-signed-out member', async () => {
    const client = fakeClient(() => Promise.resolve({}));

    await revokeMemberSession(client, { userPoolId: 'pool-1', username: 'mbr-102' });
    await revokeMemberSession(client, { userPoolId: 'pool-1', username: 'mbr-102' });

    expect(
      logSpy.mock.calls.filter((call) => (call[0] as string).includes('RevocationSucceeded')),
    ).toHaveLength(2);
  });

  it('logs the original error with the identifying username, emits a Skipped metric (not Failed), and rethrows on UserNotFoundException', async () => {
    const client = fakeClient(() =>
      Promise.reject(new UserNotFoundException({ message: 'no such user', $metadata: {} })),
    );

    await expect(
      revokeMemberSession(client, { userPoolId: 'pool-1', username: 'unknown-member' }),
    ).rejects.toBeInstanceOf(UserNotFoundException);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('sessionRevocation.skipped'));
    const errorLog = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as {
      reason: string;
      username: string;
    };
    expect(errorLog.reason).toBe('UserNotFoundException');
    expect(errorLog.username).toBe('unknown-member');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('RevocationSkipped'));
    expect(logSpy.mock.calls.some((call) => (call[0] as string).includes('RevocationFailed'))).toBe(
      false,
    );
  });

  it('discriminates a transient/unavailable Cognito error from an unknown-user error by constructor.name', async () => {
    const client = fakeClient(() =>
      Promise.reject(new TooManyRequestsException({ message: 'throttled', $metadata: {} })),
    );

    await expect(
      revokeMemberSession(client, { userPoolId: 'pool-1', username: 'mbr-102' }),
    ).rejects.toBeInstanceOf(TooManyRequestsException);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('sessionRevocation.failed'));
    const errorLog = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as {
      reason: string;
      username: string;
    };
    expect(errorLog.reason).toBe('TooManyRequestsException');
    expect(errorLog.reason).not.toBe('UserNotFoundException');
    expect(errorLog.username).toBe('mbr-102');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('RevocationFailed'));
  });
});

describe('resolveMemberDeptId', () => {
  it('returns the custom:deptId attribute from AdminGetUser', async () => {
    const sent: unknown[] = [];
    const client = fakeClient((command) => {
      sent.push(command);
      return Promise.resolve({
        UserAttributes: [
          { Name: 'sub', Value: 'abc' },
          { Name: 'custom:deptId', Value: 'dept-001' },
        ],
      });
    });

    const deptId = await resolveMemberDeptId(client, { userPoolId: 'pool-1', username: 'mbr-102' });

    expect(deptId).toBe('dept-001');
    expect(sent[0]).toBeInstanceOf(AdminGetUserCommand);
    expect((sent[0] as AdminGetUserCommand).input).toEqual({
      UserPoolId: 'pool-1',
      Username: 'mbr-102',
    });
  });

  it('returns undefined when the user has no custom:deptId attribute', async () => {
    const client = fakeClient(() =>
      Promise.resolve({ UserAttributes: [{ Name: 'sub', Value: 'abc' }] }),
    );

    const deptId = await resolveMemberDeptId(client, { userPoolId: 'pool-1', username: 'mbr-102' });

    expect(deptId).toBeUndefined();
  });

  it('rejects with UserNotFoundException for an unknown member (fail-closed upstream)', async () => {
    const client = fakeClient(() =>
      Promise.reject(new UserNotFoundException({ message: 'no such user', $metadata: {} })),
    );

    await expect(
      resolveMemberDeptId(client, { userPoolId: 'pool-1', username: 'mbr-ghost' }),
    ).rejects.toBeInstanceOf(UserNotFoundException);
  });
});
