import { describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from './index.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

describe('buildOutboxRecord', () => {
  it('builds a department-scoped pk and an EVENT#-prefixed sk carrying the eventId', () => {
    const record = buildOutboxRecord(
      DEPT_ID,
      'inspections-service',
      'inspections.preplan.updated',
      'PP-1',
      {
        occupancyId: 'OCC-1',
      },
    );
    expect(record.pk).toBe('DEPT#NICHOLS#OUTBOX');
    expect(record.sk).toBe(`EVENT#${record.eventTime}#${record.eventId}`);
    expect(record.entityType).toBe('OUTBOX_RECORD');
  });

  it('carries the standard event envelope fields with a fresh eventId per call', () => {
    const first = buildOutboxRecord(
      DEPT_ID,
      'inspections-service',
      'inspections.preplan.updated',
      'PP-1',
      {},
    );
    const second = buildOutboxRecord(
      DEPT_ID,
      'inspections-service',
      'inspections.preplan.updated',
      'PP-1',
      {},
    );
    expect(first.eventId).not.toBe(second.eventId);
    expect(first.eventType).toBe('inspections.preplan.updated');
    expect(first.source).toBe('inspections-service');
    expect(first.correlationId).toBe('PP-1');
    expect(first.schemaVersion).toBe('1.0');
  });

  it('carries the given payload verbatim', () => {
    const payload = { occupancyId: 'OCC-1', prePlanId: 'PP-1' };
    const record = buildOutboxRecord(
      DEPT_ID,
      'inspections-service',
      'inspections.preplan.updated',
      'PP-1',
      payload,
    );
    expect(record.payload).toEqual(payload);
  });
});
