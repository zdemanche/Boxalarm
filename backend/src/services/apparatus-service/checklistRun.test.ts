import { describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  buildChecklistAuditEntry,
  buildChecklistIdempotencyLockItem,
  buildChecklistRunItem,
  parseChecklistRunItem,
  validateSubmitCheckBody,
} from './checklistRun.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-001' });

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    templateId: 'template-1',
    completedBy: 'member-1',
    completedAt: 1798052000,
    durationSeconds: 82,
    idempotencyKey: 'idem-1',
    itemResults: [{ code: 'BRAKES', pass: true }],
    ...overrides,
  };
}

describe('validateSubmitCheckBody', () => {
  it('accepts a valid body and defaults capturedOffline to false and note to null', () => {
    const result = validateSubmitCheckBody(validBody());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.capturedOffline).toBe(false);
      expect(result.value.itemResults[0]?.note).toBeNull();
    }
  });

  it('preserves capturedOffline: true and a provided note', () => {
    const result = validateSubmitCheckBody(
      validBody({
        capturedOffline: true,
        itemResults: [{ code: 'BRAKES', pass: false, note: 'pad worn' }],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.capturedOffline).toBe(true);
      expect(result.value.itemResults[0]?.note).toBe('pad worn');
    }
  });

  it('rejects a missing required field with a field-level error', () => {
    const body = validBody();
    delete body.completedBy;
    const result = validateSubmitCheckBody(body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        field: 'completedBy',
        message: 'is required and must be a non-empty string',
      });
    }
  });

  it('rejects a negative durationSeconds', () => {
    const result = validateSubmitCheckBody(validBody({ durationSeconds: -1 }));
    expect(result.ok).toBe(false);
  });

  it('rejects an empty itemResults array', () => {
    const result = validateSubmitCheckBody(validBody({ itemResults: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        field: 'itemResults',
        message: 'is required and must be a non-empty array',
      });
    }
  });

  it('rejects an item result missing a required pass field', () => {
    const result = validateSubmitCheckBody(validBody({ itemResults: [{ code: 'BRAKES' }] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        field: 'itemResults[0].pass',
        message: 'is required and must be a boolean',
      });
    }
  });
});

describe('buildChecklistRunItem / parseChecklistRunItem', () => {
  it('builds an item keyed under the apparatus pk with sk CHECK#{completedAt} and no TTL', () => {
    const validation = validateSubmitCheckBody(validBody());
    if (!validation.ok) {
      throw new Error('expected valid body');
    }
    const item = buildChecklistRunItem(DEPT_ID, 'apparatus-1', validation.value);
    expect(item.pk).toBe('DEPT#dept-001#APPARATUS#apparatus-1');
    expect(item.sk).toBe('CHECK#1798052000');
    expect(item.entityType).toBe('CHECKLIST_RUN');
    expect(item.defectIds).toEqual([]);
    expect(item.gsi3pk).toBe('DEPT#dept-001#CHECKLIST_RUN');
    expect(item.gsi3sk).toBe('1798052000');
    expect(item.ttl).toBeUndefined();
  });

  it('sets syncedAt only when capturedOffline is true', () => {
    const online = validateSubmitCheckBody(validBody());
    const offline = validateSubmitCheckBody(validBody({ capturedOffline: true }));
    if (!online.ok || !offline.ok) {
      throw new Error('expected valid bodies');
    }
    expect(buildChecklistRunItem(DEPT_ID, 'apparatus-1', online.value).syncedAt).toBeNull();
    expect(buildChecklistRunItem(DEPT_ID, 'apparatus-1', offline.value).syncedAt).toEqual(
      expect.any(Number),
    );
  });

  it('round-trips completedBy/completedAt/itemResults/durationSeconds through build then parse (AC1)', () => {
    const validation = validateSubmitCheckBody(validBody());
    if (!validation.ok) {
      throw new Error('expected valid body');
    }
    const item = buildChecklistRunItem(DEPT_ID, 'apparatus-1', validation.value);
    const parsed = parseChecklistRunItem(item, 'apparatus-1', DEPT_ID);
    expect(parsed.completedBy).toBe('member-1');
    expect(parsed.completedAt).toBe(1798052000);
    expect(parsed.durationSeconds).toBe(82);
    expect(parsed.itemResults).toEqual([{ code: 'BRAKES', pass: true, note: null }]);
  });
});

describe('buildChecklistIdempotencyLockItem', () => {
  it('keys the lock item under CHECK_IDEMPOTENCY and carries the check sk it resolves to', () => {
    const lock = buildChecklistIdempotencyLockItem(DEPT_ID, 'idem-1', 'CHECK#1798052000');
    expect(lock.pk).toBe('DEPT#dept-001#CHECK_IDEMPOTENCY#idem-1');
    expect(lock.sk).toBe('LOCK');
    expect(lock.checkSk).toBe('CHECK#1798052000');
  });
});

describe('buildChecklistAuditEntry', () => {
  it('builds an AUDIT_LOG_ENTRY keyed by AUDIT#{date} with the actor and mutated entity (F9.4)', () => {
    const entry = buildChecklistAuditEntry(
      DEPT_ID,
      'apparatus-1',
      1798052000,
      'member-1',
      1798052000,
    );
    expect(entry.pk).toBe('DEPT#dept-001#AUDIT#2026-12-23');
    expect(entry.sk).toBe('1798052000#CHECKLIST_RUN#apparatus-1-1798052000#member-1');
    expect(entry.entityType).toBe('AUDIT_LOG_ENTRY');
    expect(entry.mutatedEntityType).toBe('CHECKLIST_RUN');
    expect(entry.actorId).toBe('member-1');
  });
});
