import { describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  deriveIngressIdempotencyKey,
  manualEntryAdapter,
  normalizeManualEntry,
} from './dispatchIngressPort.js';

const validPayload = {
  incidentType: 'STRUCTURE_FIRE',
  address: '123 Main St',
  crossStreets: 'Main & Elm',
  narrative: 'Smoke showing, 2nd floor',
  externalDispatchId: 'op-entered-4471',
  unitsRequested: ['ENGINE-2', 'LADDER-1'],
};

describe('normalizeManualEntry (AC1)', () => {
  it('normalizes a valid manual payload into a DispatchReceived carrying every AC1 field', () => {
    const result = normalizeManualEntry(validPayload);
    expect(result).toEqual({
      ok: true,
      value: {
        sourceSystem: 'MANUAL',
        incidentType: 'STRUCTURE_FIRE',
        address: '123 Main St',
        crossStreets: 'Main & Elm',
        unitsRequested: ['ENGINE-2', 'LADDER-1'],
        narrative: 'Smoke showing, 2nd floor',
        externalDispatchId: 'op-entered-4471',
      },
    });
  });

  it('defaults unitsRequested to an empty array when absent', () => {
    const withoutUnits: Record<string, unknown> = { ...validPayload };
    delete withoutUnits.unitsRequested;
    const result = normalizeManualEntry(withoutUnits);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.unitsRequested).toEqual([]);
  });

  it('rejects an absent request body', () => {
    const result = normalizeManualEntry(undefined);
    expect(result).toEqual({
      ok: false,
      errors: [{ field: 'body', message: 'request body must be a JSON object' }],
    });
  });

  it('rejects a required field that is missing', () => {
    const withoutAddress: Record<string, unknown> = { ...validPayload };
    delete withoutAddress.address;
    const result = normalizeManualEntry(withoutAddress);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toContainEqual(
      expect.objectContaining({ field: 'address' }),
    );
  });

  it('rejects a wrong-typed field (narrative as a number)', () => {
    const result = normalizeManualEntry({ ...validPayload, narrative: 12345 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toContainEqual(
      expect.objectContaining({ field: 'narrative' }),
    );
  });

  it('rejects a wrong-typed unitsRequested entry', () => {
    const result = normalizeManualEntry({ ...validPayload, unitsRequested: ['ENGINE-2', 7] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toContainEqual(
      expect.objectContaining({ field: 'unitsRequested' }),
    );
  });

  it("rejects externalDispatchId containing '#', the pk delimiter, with a 400-shaped field error rather than a 500", () => {
    const result = normalizeManualEntry({ ...validPayload, externalDispatchId: 'bad#id' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toContainEqual(
      expect.objectContaining({ field: 'externalDispatchId' }),
    );
  });

  it('reports every violated field in one response rather than stopping at the first', () => {
    const result = normalizeManualEntry({ incidentType: '' });
    expect(result.ok).toBe(false);
    const fields = (!result.ok && result.errors.map((e) => e.field)) || [];
    expect(fields).toEqual(
      expect.arrayContaining([
        'incidentType',
        'address',
        'crossStreets',
        'narrative',
        'externalDispatchId',
      ]),
    );
  });
});

describe('manualEntryAdapter (DispatchIngressPort, AC1)', () => {
  it('identifies itself as the MANUAL source system and normalizes through the same contract', () => {
    expect(manualEntryAdapter.sourceSystem).toBe('MANUAL');
    expect(manualEntryAdapter.normalize(validPayload)).toEqual(normalizeManualEntry(validPayload));
  });
});

describe('deriveIngressIdempotencyKey (AC4, pure and deterministic)', () => {
  const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

  it('derives the same key for the same inputs (deterministic)', () => {
    const first = deriveIngressIdempotencyKey(deptId, 'MANUAL', 'op-4471');
    const second = deriveIngressIdempotencyKey(deptId, 'MANUAL', 'op-4471');
    expect(first).toBe(second);
    expect(first).toBe('MANUAL#NICHOLS#op-4471');
  });

  it('derives a different key for a different externalDispatchId', () => {
    const first = deriveIngressIdempotencyKey(deptId, 'MANUAL', 'op-4471');
    const second = deriveIngressIdempotencyKey(deptId, 'MANUAL', 'op-4472');
    expect(first).not.toBe(second);
  });

  it('derives a different key for a different sourceSystem, so a future CAD adapter cannot collide with a manual entry sharing the same reference', () => {
    const manual = deriveIngressIdempotencyKey(deptId, 'MANUAL', 'shared-ref');
    const cad = deriveIngressIdempotencyKey(deptId, 'CAD', 'shared-ref');
    expect(manual).not.toBe(cad);
  });
});
