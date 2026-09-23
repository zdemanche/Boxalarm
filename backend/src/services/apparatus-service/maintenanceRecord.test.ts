import { describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { buildMaintenanceRecordItem, parseMaintenanceRecordItem } from './maintenanceRecord.js';
import { readApparatusTableConfig } from './dynamoClient.js';
import { apparatusNotFoundProblem, validationProblem } from './problemDetails.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-001' });

describe('buildMaintenanceRecordItem', () => {
  it('writes gsi2pk/gsi2sk in the shared due-soon shape when scheduledNextAt is present', () => {
    const item = buildMaintenanceRecordItem(DEPT_ID, 'APP-ENGINE-2', {
      performedAt: 1798052000,
      description: 'Brake service',
      vendor: 'Acme Fleet',
      cost: 450,
      scheduledNextAt: 1798052000 + 60 * 60 * 24 * 90,
    });

    expect(item.pk).toBe('DEPT#dept-001#APPARATUS#APP-ENGINE-2');
    expect(item.sk).toBe('MAINT#1798052000');
    expect(item.entityType).toBe('MAINTENANCE_RECORD');
    expect(item.gsi2pk).toMatch(/^DEPT#dept-001#DUE#MAINTENANCE_RECORD#\d{4}-\d{2}$/);
    expect(item.gsi2sk).toBe(`${1798052000 + 60 * 60 * 24 * 90}#APP-ENGINE-2`);
  });

  it('omits gsi2pk/gsi2sk when scheduledNextAt is absent', () => {
    const item = buildMaintenanceRecordItem(DEPT_ID, 'APP-ENGINE-2', {
      performedAt: 1798052000,
      description: 'Oil change',
      vendor: 'Acme Fleet',
      cost: 120,
      scheduledNextAt: null,
    });

    expect(item.gsi2pk).toBeUndefined();
    expect(item.gsi2sk).toBeUndefined();
    expect(item.scheduledNextAt).toBeNull();
  });

  it('scopes different departments to different pk/gsi2pk for the same apparatus (core-harm)', () => {
    const deptA = toVerifiedDeptId({ deptId: 'dept-a' });
    const deptB = toVerifiedDeptId({ deptId: 'dept-b' });
    const itemA = buildMaintenanceRecordItem(deptA, 'ENGINE-2', {
      performedAt: 1,
      description: 'x',
      vendor: 'y',
      cost: 1,
      scheduledNextAt: 100,
    });
    const itemB = buildMaintenanceRecordItem(deptB, 'ENGINE-2', {
      performedAt: 1,
      description: 'x',
      vendor: 'y',
      cost: 1,
      scheduledNextAt: 100,
    });

    expect(itemA.pk).not.toBe(itemB.pk);
    expect(itemA.gsi2pk).not.toBe(itemB.gsi2pk);
  });
});

describe('parseMaintenanceRecordItem', () => {
  it('round-trips a stored item back into a MaintenanceRecord', () => {
    const item = buildMaintenanceRecordItem(DEPT_ID, 'APP-ENGINE-2', {
      performedAt: 1798052000,
      description: 'Brake service',
      vendor: 'Acme Fleet',
      cost: 450,
      scheduledNextAt: 1798100000,
    });

    const record = parseMaintenanceRecordItem(item, 'APP-ENGINE-2', 'dept-001');

    expect(record).toEqual({
      apparatusId: 'APP-ENGINE-2',
      deptId: 'dept-001',
      performedAt: 1798052000,
      description: 'Brake service',
      vendor: 'Acme Fleet',
      cost: 450,
      scheduledNextAt: 1798100000,
    });
  });
});

describe('readApparatusTableConfig', () => {
  it('reads PLATFORM_TABLE_NAME', () => {
    expect(readApparatusTableConfig({ PLATFORM_TABLE_NAME: 'platform-table' })).toEqual({
      tableName: 'platform-table',
    });
  });

  it('throws (fail-closed) when PLATFORM_TABLE_NAME is missing', () => {
    expect(() => readApparatusTableConfig({})).toThrow('PLATFORM_TABLE_NAME is required');
  });
});

describe('apparatusNotFoundProblem', () => {
  it('returns a 404 RFC 7807 body carrying the traceId', () => {
    const response = apparatusNotFoundProblem('trace-abc');
    expect(response.statusCode).toBe(404);
    expect(response.headers).toEqual({ 'content-type': 'application/problem+json' });
    const body = JSON.parse(response.body) as { status: number; traceId: string };
    expect(body.status).toBe(404);
    expect(body.traceId).toBe('trace-abc');
  });
});

describe('validationProblem', () => {
  it('returns a 400 RFC 7807 body carrying a field-level errors array', () => {
    const response = validationProblem('trace-xyz', [
      { field: 'cost', message: 'is required and must be a finite number' },
    ]);
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as {
      status: number;
      traceId: string;
      errors: { field: string; message: string }[];
    };
    expect(body.status).toBe(400);
    expect(body.traceId).toBe('trace-xyz');
    expect(body.errors).toEqual([
      { field: 'cost', message: 'is required and must be a finite number' },
    ]);
  });
});
