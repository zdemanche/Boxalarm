import { describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import {
  buildAuditLogEntryItem,
  buildAuditLogEntryTransactItem,
  diffChangedFields,
  emitAuditWriteOutcome,
  parseAuditLogEntryItem,
} from './auditEntry.js';

const DEPT_ID: VerifiedDeptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    deptId: DEPT_ID,
    actorId: 'MBR-0034',
    mutatedEntityType: 'CERTIFICATION',
    mutatedEntityId: 'CERT-0091',
    action: 'UPDATE' as const,
    before: { expiryDate: '2026-01-10' },
    after: { expiryDate: '2027-01-10' },
    ts: 1788436800000,
    ...overrides,
  };
}

describe('diffChangedFields', () => {
  it('treats every field on a CREATE (before=undefined) as changed', () => {
    expect(diffChangedFields(undefined, { name: 'Jane', rank: 'LT' })).toEqual({
      name: { old: undefined, new: 'Jane' },
      rank: { old: undefined, new: 'LT' },
    });
  });

  it('produces an empty diff when before and after are deep-equal (no-op update)', () => {
    expect(diffChangedFields({ status: 'ACTIVE' }, { status: 'ACTIVE' })).toEqual({});
  });

  it('carries a PII-bearing field diff through unredacted, since that is the audit point', () => {
    expect(diffChangedFields({ phone: '203-555-0100' }, { phone: '203-555-0199' })).toEqual({
      phone: { old: '203-555-0100', new: '203-555-0199' },
    });
  });
});

describe('buildAuditLogEntryItem', () => {
  it('builds pk/sk/gsi3pk/gsi3sk per Data Model §3.3', () => {
    const item = buildAuditLogEntryItem(baseInput());
    expect(item.pk).toBe('DEPT#NICHOLS#AUDIT#2026-09-03');
    expect(item.sk).toBe('1788436800000#CERTIFICATION#CERT-0091#MBR-0034');
    expect(item.gsi3pk).toBe('DEPT#NICHOLS#AUDIT#ENTITY#CERTIFICATION#CERT-0091');
    expect(item.gsi3sk).toBe('1788436800000');
    expect(item.entityType).toBe('AUDIT_LOG_ENTRY');
    expect(item.changedFields).toEqual({ expiryDate: { old: '2026-01-10', new: '2027-01-10' } });
  });
});

describe('buildAuditLogEntryTransactItem — failure-mode matrix', () => {
  it('throws when deptId is empty/absent', () => {
    expect(() => buildAuditLogEntryTransactItem('table', baseInput({ deptId: '' }))).toThrow(
      /deptId/,
    );
  });

  it('throws when actorId is empty/absent', () => {
    expect(() => buildAuditLogEntryTransactItem('table', baseInput({ actorId: '' }))).toThrow(
      /actorId/,
    );
  });

  it('throws when action is not CREATE|UPDATE|DELETE', () => {
    expect(() => buildAuditLogEntryTransactItem('table', baseInput({ action: 'PATCH' }))).toThrow(
      /action must be one of/,
    );
  });

  it('throws when mutatedEntityId is empty string', () => {
    expect(() =>
      buildAuditLogEntryTransactItem('table', baseInput({ mutatedEntityId: '' })),
    ).toThrow(/mutatedEntityId/);
  });

  it('shapes a TransactWriteItems Put, never a BatchWriteItem entry', () => {
    const transactItem = buildAuditLogEntryTransactItem('platform-table', baseInput());
    expect(transactItem.Put?.TableName).toBe('platform-table');
    expect(transactItem.Put?.ConditionExpression).toContain('attribute_not_exists');
  });
});

describe('parseAuditLogEntryItem', () => {
  it('round-trips a built item back to the same typed entry', () => {
    const item = buildAuditLogEntryItem(baseInput());
    expect(parseAuditLogEntryItem(item as unknown as Record<string, unknown>)).toEqual(item);
  });

  it('throws on a malformed item', () => {
    expect(() => parseAuditLogEntryItem({ entityType: 'AUDIT_LOG_ENTRY' })).toThrow(/malformed/);
  });
});

// emitAuditWriteOutcome is the AC1-conformant seam: a composing service (e.g.
// personnel-service) puts buildAuditLogEntryTransactItem's output into its OWN
// TransactWriteItems call alongside the domain mutation, then reports the settled
// outcome here — this is what makes the audit write atomic with the mutation it
// records, which a self-contained write-then-audit call could not guarantee.
describe('emitAuditWriteOutcome', () => {
  it('emits the AuditEntryWritten business metric on success', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    emitAuditWriteOutcome(baseInput());
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('AuditEntryWritten'));
  });

  it('logs the original error with CancellationReasons and emits AuditEntryWriteFailed on failure', () => {
    const cancellation = new TransactionCanceledException({
      message: 'cancelled',
      $metadata: {},
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    const errorSpy = vi.fn();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.resetModules();
    vi.doMock('./dynamoClient.js', () => ({ logger: { error: errorSpy } }));

    return import('./auditEntry.js').then(({ emitAuditWriteOutcome: freshEmitOutcome }) => {
      freshEmitOutcome(baseInput({ traceId: 'trace-1' }), cancellation);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'audit.entry.write_failed',
          reason: 'TransactionCanceledException',
          cancellationReasons: ['ConditionalCheckFailed'],
          traceId: 'trace-1',
        }),
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('AuditEntryWriteFailed'));
      vi.doUnmock('./dynamoClient.js');
      vi.resetModules();
    });
  });
});
