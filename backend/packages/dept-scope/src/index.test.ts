import { describe, expect, it } from 'vitest';
import { buildDeptScopedPk, findPkScopingViolations, toVerifiedDeptId } from './index.js';

describe('toVerifiedDeptId', () => {
  it('mints a VerifiedDeptId from a verified principal', () => {
    expect(toVerifiedDeptId({ deptId: 'NICHOLS' })).toBe('NICHOLS');
  });

  it('throws when the principal has no deptId', () => {
    expect(() => toVerifiedDeptId({ deptId: undefined as unknown as string })).toThrow(
      'deptId is required on the verified principal',
    );
  });

  it('throws when the principal deptId is an empty string', () => {
    expect(() => toVerifiedDeptId({ deptId: '' })).toThrow(
      'deptId is required on the verified principal',
    );
  });

  it('throws when the principal deptId contains the pk delimiter', () => {
    expect(() => toVerifiedDeptId({ deptId: 'A#MEMBER' })).toThrow("deptId cannot contain '#'");
  });
});

describe('buildDeptScopedPk', () => {
  const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

  it('prefixes every entity pk with DEPT#{deptId}', () => {
    expect(buildDeptScopedPk(deptId, 'MEMBER', 'MBR-0012')).toBe('DEPT#NICHOLS#MEMBER#MBR-0012');
  });

  it('returns DEPT#{deptId} alone for the zero-segment DEPARTMENT_CONFIG shape', () => {
    expect(buildDeptScopedPk(deptId)).toBe('DEPT#NICHOLS');
  });

  it('throws when deptId is empty (fail-closed, never builds an unscoped key)', () => {
    expect(() => buildDeptScopedPk('' as unknown as typeof deptId, 'MEMBER', 'MBR-0012')).toThrow(
      'deptId is required to build a department-scoped pk',
    );
  });

  it('throws when a segment contains the pk delimiter', () => {
    expect(() => buildDeptScopedPk(deptId, 'MEMBER', 'x#DEPARTMENT_CONFIG')).toThrow(
      "segment at index 1 cannot contain '#'",
    );
  });

  it('throws when a segment is an empty string', () => {
    expect(() => buildDeptScopedPk(deptId, 'MEMBER', '')).toThrow(
      'segment at index 1 is required to build a department-scoped pk',
    );
  });
});

describe('findPkScopingViolations', () => {
  it('returns no violations for an empty source text', () => {
    expect(findPkScopingViolations('')).toEqual([]);
  });

  it('returns no violations when every pk literal starts with DEPT#${deptId}', () => {
    const source = 'const item = { pk: `DEPT#${deptId}#MEMBER#${memberId}`, sk: `METADATA` };';
    expect(findPkScopingViolations(source)).toEqual([]);
  });

  it('returns no violations when pk is built via buildDeptScopedPk', () => {
    const source = "const item = { pk: buildDeptScopedPk(deptId, 'MEMBER', memberId) };";
    expect(findPkScopingViolations(source)).toEqual([]);
  });

  it('flags a pk literal that omits the DEPT#${deptId} scoping seam', () => {
    const source = 'const item = { pk: `MEMBER#${memberId}`, sk: `METADATA` };';
    expect(findPkScopingViolations(source)).toEqual(['pk: `MEMBER#${memberId}`']);
  });

  it('flags a pk built via string concatenation', () => {
    const source = "const item = { pk: 'MEMBER#' + memberId };";
    expect(findPkScopingViolations(source)).toHaveLength(1);
  });

  it('flags a double-quoted pk literal', () => {
    const source = 'const item = { pk: "CONFIG#DEFAULT" };';
    expect(findPkScopingViolations(source)).toHaveLength(1);
  });

  it('flags a marshalled AttributeValue pk', () => {
    const source = 'const item = { pk: { S: `MEMBER#${memberId}` } };';
    expect(findPkScopingViolations(source)).toHaveLength(1);
  });

  it('flags a quoted "pk" property key', () => {
    const source = 'const item = { "pk": `MEMBER#${memberId}` };';
    expect(findPkScopingViolations(source)).toHaveLength(1);
  });

  it('flags a pk assigned from an unverified identifier', () => {
    const source = 'const pkValue = `MEMBER#${id}`; const item = { pk: pkValue };';
    expect(findPkScopingViolations(source)).toHaveLength(1);
  });
});
