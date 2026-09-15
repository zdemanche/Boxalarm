import { describe, expect, it } from 'vitest';
import { ForbiddenError, requireAdminRole } from './authz.js';
import type { VerifiedAccessToken } from '../../platform-service/authorizer/tokenVerifier.js';

function ctxWithGroups(groups: string): VerifiedAccessToken {
  return { sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': groups };
}

describe('requireAdminRole', () => {
  it('allows a caller in the ADMIN group', () => {
    expect(() => requireAdminRole(ctxWithGroups('ADMIN'))).not.toThrow();
  });

  it('allows a caller in the OFFICER group', () => {
    expect(() => requireAdminRole(ctxWithGroups('MEMBER OFFICER'))).not.toThrow();
  });

  it('allows a caller in the CHIEF group', () => {
    expect(() => requireAdminRole(ctxWithGroups('CHIEF'))).not.toThrow();
  });

  it('denies a caller with no admin-gated group (fail-closed)', () => {
    expect(() => requireAdminRole(ctxWithGroups('MEMBER'))).toThrow(ForbiddenError);
  });

  it('denies a caller with an empty groups string', () => {
    expect(() => requireAdminRole(ctxWithGroups(''))).toThrow(ForbiddenError);
  });
});
