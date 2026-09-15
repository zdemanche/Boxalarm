import { describe, expect, it } from 'vitest';
import { parseRosterEntryItem } from './dispatchRosterEntry.js';

function validItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pk: 'DEPT#NICHOLS#DISPATCH#NICHOLS-4471-1798000000',
    sk: 'ROSTER#MBR-0012',
    entityType: 'DISPATCH_ROSTER_ENTRY',
    memberId: 'MBR-0012',
    quals: ['INTERIOR', 'DRIVER_OP'],
    ackStatus: 'RESPONDING',
    ackAt: 1798000012,
    eta: 6,
    assignedApparatusId: 'APP-ENGINE-2',
    lastAnsweredTone: 1,
    ...overrides,
  };
}

describe('parseRosterEntryItem', () => {
  it('returns undefined for an absent item', () => {
    expect(parseRosterEntryItem(undefined)).toBeUndefined();
  });

  it('parses a fully populated roster entry (AC4, AC5)', () => {
    const parsed = parseRosterEntryItem(validItem());
    expect(parsed).toMatchObject({
      memberId: 'MBR-0012',
      quals: ['INTERIOR', 'DRIVER_OP'],
      ackStatus: 'RESPONDING',
      eta: 6,
      assignedApparatusId: 'APP-ENGINE-2',
    });
  });

  it('distinguishes DIRECT_TO_SCENE from RESPONDING (AC5)', () => {
    const parsed = parseRosterEntryItem(validItem({ ackStatus: 'DIRECT_TO_SCENE' }));
    expect(parsed?.ackStatus).toBe('DIRECT_TO_SCENE');
  });

  it('defaults quals to an empty array and nullable fields to null when absent (E1-S2 not yet landed)', () => {
    const parsed = parseRosterEntryItem(
      validItem({
        quals: undefined,
        ackAt: undefined,
        eta: undefined,
        assignedApparatusId: undefined,
        lastAnsweredTone: undefined,
      }),
    );
    expect(parsed).toMatchObject({
      quals: [],
      ackAt: null,
      eta: null,
      assignedApparatusId: null,
      lastAnsweredTone: null,
    });
  });

  it('defaults ackStatus to NONE for a fan-out-created row with no ackStatus yet (P6)', () => {
    const parsed = parseRosterEntryItem(
      validItem({
        ackStatus: undefined,
        ackAt: undefined,
        eta: undefined,
        lastAnsweredTone: undefined,
      }),
    );
    expect(parsed?.ackStatus).toBe('NONE');
  });

  it('throws on an invalid ackStatus (shape validation)', () => {
    expect(() => parseRosterEntryItem(validItem({ ackStatus: 'BOGUS' }))).toThrow(
      'DISPATCH_ROSTER_ENTRY item failed shape validation',
    );
  });

  it('throws when entityType does not match the discriminator', () => {
    expect(() => parseRosterEntryItem(validItem({ entityType: 'DISPATCH_ALERT' }))).toThrow(
      'DISPATCH_ROSTER_ENTRY item failed shape validation',
    );
  });

  it('throws when a nullable numeric field is wrong-typed', () => {
    expect(() => parseRosterEntryItem(validItem({ eta: 'six' }))).toThrow(
      'DISPATCH_ROSTER_ENTRY item failed shape validation',
    );
  });
});
