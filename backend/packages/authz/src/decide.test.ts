import { describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { AuthzUnavailableError, batchIsAuthorized, isAuthorized } from './decide.js';

const CONFIG = { policyStoreId: 'ps-1' };
const ACTION = {
  actionType: 'Boxalarm::Action',
  actionId: 'ReadConfig',
  resourceType: 'Boxalarm::Config',
  resourceId: 'cfg-1',
};

function fakeClient(send: (command: unknown) => Promise<unknown>): VerifiedPermissionsClient {
  return { send } as unknown as VerifiedPermissionsClient;
}

describe('isAuthorized', () => {
  it('returns true on an explicit ALLOW decision', async () => {
    const client = fakeClient(() => Promise.resolve({ decision: Decision.ALLOW }));
    await expect(isAuthorized(client, CONFIG, 'token', ACTION)).resolves.toBe(true);
  });

  it('returns false on an explicit DENY decision (distinguishable from an outage)', async () => {
    const client = fakeClient(() => Promise.resolve({ decision: Decision.DENY }));
    await expect(isAuthorized(client, CONFIG, 'token', ACTION)).resolves.toBe(false);
  });

  it('throws AuthzUnavailableError (never a defaulted allow), reason carrying the error constructor name so it survives name-mangled bundling', async () => {
    class ThrottlingException extends Error {}
    const client = fakeClient(() => Promise.reject(new ThrottlingException('slow down')));
    const result = isAuthorized(client, CONFIG, 'token', ACTION);
    await expect(result).rejects.toBeInstanceOf(AuthzUnavailableError);
    await expect(result).rejects.toMatchObject({ reason: 'ThrottlingException' });
  });
});

describe('batchIsAuthorized', () => {
  it('issues exactly one BatchIsAuthorizedWithToken call for N resources (AC2)', async () => {
    const send = vi.fn().mockResolvedValue({
      results: [
        { decision: Decision.ALLOW },
        { decision: Decision.DENY },
        { decision: Decision.ALLOW },
      ],
    });
    const client = fakeClient(send);
    const decisions = await batchIsAuthorized(client, CONFIG, 'token', 'A', 'Read', 'R', [
      'r-1',
      'r-2',
      'r-3',
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(decisions).toEqual([
      { resourceId: 'r-1', allowed: true },
      { resourceId: 'r-2', allowed: false },
      { resourceId: 'r-3', allowed: true },
    ]);
  });

  it('returns an empty result and makes zero VP calls for an empty resource list', async () => {
    const send = vi.fn();
    const client = fakeClient(send);
    await expect(batchIsAuthorized(client, CONFIG, 'token', 'A', 'Read', 'R', [])).resolves.toEqual(
      [],
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('throws synchronously for a wrong-typed resourceId before any VP call', async () => {
    const send = vi.fn();
    const client = fakeClient(send);
    await expect(
      batchIsAuthorized(client, CONFIG, 'token', 'A', 'Read', 'R', [
        'r-1',
        42 as unknown as string,
      ]),
    ).rejects.toThrow(TypeError);
    expect(send).not.toHaveBeenCalled();
  });

  it('throws AuthzUnavailableError and returns no partial list when the client throws mid-batch', async () => {
    const client = fakeClient(() => Promise.reject(new Error('VP outage')));
    await expect(
      batchIsAuthorized(client, CONFIG, 'token', 'A', 'Read', 'R', ['r-1', 'r-2']),
    ).rejects.toBeInstanceOf(AuthzUnavailableError);
  });
});
