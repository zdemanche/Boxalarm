import { describe, expect, it } from 'vitest';
import { assertChiefOrAdmin, ForbiddenError } from './authz.js';

describe('assertChiefOrAdmin', () => {
  it('allows CHIEF', () => {
    expect(() => assertChiefOrAdmin('CHIEF')).not.toThrow();
  });

  it('allows ADMIN among multiple space-joined groups', () => {
    expect(() => assertChiefOrAdmin('MEMBER ADMIN OFFICER')).not.toThrow();
  });

  it('denies (fail-closed) an empty groups string, treating it as zero groups', () => {
    expect(() => assertChiefOrAdmin('')).toThrow(ForbiddenError);
  });

  it('denies a non-admin/chief role', () => {
    expect(() => assertChiefOrAdmin('MEMBER OFFICER')).toThrow(ForbiddenError);
  });
});
