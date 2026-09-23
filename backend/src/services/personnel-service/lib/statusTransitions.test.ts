import { describe, expect, it } from 'vitest';
import { isValidStatusTransition } from './statusTransitions.js';

describe('isValidStatusTransition', () => {
  it.each([
    ['PROBATIONARY', 'ACTIVE'],
    ['PROBATIONARY', 'LOA'],
    ['PROBATIONARY', 'RETIRED'],
    ['ACTIVE', 'LOA'],
    ['LOA', 'ACTIVE'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(isValidStatusTransition(from, to)).toBe(true);
  });

  it('rejects a same-status no-op transition', () => {
    expect(isValidStatusTransition('ACTIVE', 'ACTIVE')).toBe(false);
  });

  it('rejects any transition out of the terminal RETIRED status', () => {
    expect(isValidStatusTransition('RETIRED', 'ACTIVE')).toBe(false);
    expect(isValidStatusTransition('RETIRED', 'LOA')).toBe(false);
  });
});
