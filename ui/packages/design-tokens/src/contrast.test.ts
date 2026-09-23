import { describe, expect, test } from 'vitest';
import { contrastRatio, meetsAA } from './contrast';

describe('contrastRatio', () => {
  test('black on white is the maximum ratio, 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  test('identical colors have a ratio of 1:1', () => {
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
  });

  test('is symmetric regardless of argument order', () => {
    const a = contrastRatio('#101114', '#ffffff');
    const b = contrastRatio('#ffffff', '#101114');
    expect(a).toBeCloseTo(b, 5);
  });
});

describe('meetsAA', () => {
  test('black text on white background passes normal-text AA (>= 4.5:1)', () => {
    expect(meetsAA('#000000', '#ffffff', 'normal')).toBe(true);
  });

  test('light gray on white fails normal-text AA', () => {
    expect(meetsAA('#cccccc', '#ffffff', 'normal')).toBe(false);
  });

  test('large-text/UI threshold (3:1) is more permissive than normal-text (4.5:1)', () => {
    // #888888 on white is ~3.54:1 — between the 3:1 and 4.5:1 thresholds
    expect(meetsAA('#888888', '#ffffff', 'normal')).toBe(false);
    expect(meetsAA('#888888', '#ffffff', 'large')).toBe(true);
  });
});
