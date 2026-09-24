import { describe, expect, it } from 'vitest';
import { isPredicateMet } from './toneLadder.js';

describe('isPredicateMet', () => {
  it('is unmet when no member has responded', () => {
    expect(
      isPredicateMet([{ ackStatus: 'NONE', quals: [] }], { minResponders: 1, requiredQuals: [] }),
    ).toBe(false);
  });

  it('is met once minResponders acknowledge RESPONDING or DIRECT_TO_SCENE', () => {
    expect(
      isPredicateMet(
        [
          { ackStatus: 'RESPONDING', quals: [] },
          { ackStatus: 'DIRECT_TO_SCENE', quals: [] },
        ],
        { minResponders: 2, requiredQuals: [] },
      ),
    ).toBe(true);
  });

  it('requires a qualifying responder when requiredQuals is set — a head count alone is not enough', () => {
    const roster = [{ ackStatus: 'RESPONDING', quals: ['DRIVER'] }];
    expect(isPredicateMet(roster, { minResponders: 1, requiredQuals: ['INTERIOR'] })).toBe(false);
    expect(isPredicateMet(roster, { minResponders: 1, requiredQuals: ['DRIVER'] })).toBe(true);
  });

  it('NOT_RESPONDING never counts toward the predicate', () => {
    expect(
      isPredicateMet([{ ackStatus: 'NOT_RESPONDING', quals: [] }], {
        minResponders: 1,
        requiredQuals: [],
      }),
    ).toBe(false);
  });
});
