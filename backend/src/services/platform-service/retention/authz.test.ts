import { describe, expect, it } from 'vitest';
import { assertChiefOrAdmin, ForbiddenError } from './authz.js';

describe('retention assertChiefOrAdmin', () => {
  it('allows CHIEF and ADMIN without any step-up challenge', () => {
    expect(() => assertChiefOrAdmin('CHIEF')).not.toThrow();
    expect(() => assertChiefOrAdmin('MEMBER ADMIN')).not.toThrow();
  });

  it('denies non-admin roles', () => {
    expect(() => assertChiefOrAdmin('MEMBER OFFICER')).toThrow(ForbiddenError);
    expect(() => assertChiefOrAdmin('')).toThrow(ForbiddenError);
  });
});
