import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';

describe('readAuthzConfig', () => {
  it('reads the policy store id', async () => {
    const { readAuthzConfig } = await import('./client.js');
    expect(readAuthzConfig({ VERIFIED_PERMISSIONS_POLICY_STORE_ID: 'ps-1' })).toEqual({
      policyStoreId: 'ps-1',
    });
  });

  it('throws when VERIFIED_PERMISSIONS_POLICY_STORE_ID is missing (empty/absent-input row)', async () => {
    const { readAuthzConfig } = await import('./client.js');
    expect(() => readAuthzConfig({})).toThrow('VERIFIED_PERMISSIONS_POLICY_STORE_ID is required');
  });
});

describe('createAuthzClient', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws (fail-closed) instead of returning a client when config is missing', async () => {
    delete process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID;
    const { createAuthzClient } = await import('./client.js');
    expect(() => createAuthzClient(process.env)).toThrow(
      'VERIFIED_PERMISSIONS_POLICY_STORE_ID is required',
    );
  });

  it('constructs a client once and reuses the same instance across calls', async () => {
    const { createAuthzClient } = await import('./client.js');
    const fakeClient = {} as VerifiedPermissionsClient;
    const first = createAuthzClient(process.env, fakeClient);
    const second = createAuthzClient(process.env);
    expect(first).toBe(fakeClient);
    expect(second).toBe(fakeClient);
  });
});
