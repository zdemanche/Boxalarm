import { describe, expect, test } from 'vitest';
import { meetsAA } from './contrast';
import { elevation, iconSize, palette, radius, spacing, touchTarget, typography } from './index';

describe('palette', () => {
  test.each(['day', 'cab'] as const)(
    '%s palette background/foreground meets AA for normal text',
    (name) => {
      const { background, foreground } = palette[name];
      expect(meetsAA(background, foreground, 'normal')).toBe(true);
    },
  );

  test.each(['day', 'cab'] as const)('%s palette accent meets AA for large text/UI', (name) => {
    const { background, accent } = palette[name];
    expect(meetsAA(background, accent, 'large')).toBe(true);
  });

  test.each(['day', 'cab'] as const)(
    '%s palette semantic colors each meet AA for large text/UI',
    (name) => {
      const { background, error, success, warning } = palette[name];
      expect(meetsAA(background, error, 'large')).toBe(true);
      expect(meetsAA(background, success, 'large')).toBe(true);
      expect(meetsAA(background, warning, 'large')).toBe(true);
    },
  );

  // Phase 8 hardening: several screens use accent/success/warning as regular-weight body/small
  // text (status labels, links), not just large headers or button fills - the 'large' AA check
  // above isn't sufficient proof those usages are legible. Semantic colors must clear the
  // stricter 4.5:1 normal-text bar unconditionally so every usage site is safe by construction.
  test.each(['day', 'cab'] as const)(
    '%s palette semantic colors each meet AA for normal (small/body) text too',
    (name) => {
      const { background, accent, error, success, warning } = palette[name];
      expect(meetsAA(background, accent, 'normal')).toBe(true);
      expect(meetsAA(background, error, 'normal')).toBe(true);
      expect(meetsAA(background, success, 'normal')).toBe(true);
      expect(meetsAA(background, warning, 'normal')).toBe(true);
    },
  );

  test('day and cab palettes are not simple inversions of each other', () => {
    // guards against the AA note's explicit requirement: "not derived by simply
    // inverting the default theme" - day.background inverted should not equal cab.background
    const invert = (hex: string) =>
      '#' +
      hex
        .replace('#', '')
        .match(/../g)!
        .map((h) => (255 - parseInt(h, 16)).toString(16).padStart(2, '0'))
        .join('');
    expect(palette.cab.background.toLowerCase()).not.toBe(
      invert(palette.day.background).toLowerCase(),
    );
  });
});

describe('typography', () => {
  test('scale is ordered smallest to largest', () => {
    const { xs, sm, base, lg, xl, xxl, display } = typography.size;
    expect(sm).toBeGreaterThan(xs);
    expect(base).toBeGreaterThan(sm);
    expect(lg).toBeGreaterThan(base);
    expect(xl).toBeGreaterThan(lg);
    expect(xxl).toBeGreaterThan(xl);
    expect(display).toBeGreaterThan(xxl);
  });

  test('line height is generous enough for outdoor/low-light legibility (>= 1.4)', () => {
    expect(typography.lineHeight).toBeGreaterThanOrEqual(1.4);
  });
});

describe('touchTarget', () => {
  test('baseline meets N3.5 minimums (44pt iOS / 48dp Android)', () => {
    expect(touchTarget.baseline.ios).toBeGreaterThanOrEqual(44);
    expect(touchTarget.baseline.android).toBeGreaterThanOrEqual(48);
  });

  test('oversized target exceeds baseline for glove/moving-vehicle screens', () => {
    expect(touchTarget.oversized.ios).toBeGreaterThan(touchTarget.baseline.ios);
    expect(touchTarget.oversized.android).toBeGreaterThan(touchTarget.baseline.android);
  });
});

describe('radius', () => {
  test('default is smaller than card', () => {
    expect(radius.default).toBeLessThan(radius.card);
  });
});

describe('elevation', () => {
  test('shadow opacity increases with each level', () => {
    expect(elevation.level1.shadowOpacity).toBeGreaterThan(elevation.level0.shadowOpacity);
    expect(elevation.level2.shadowOpacity).toBeGreaterThan(elevation.level1.shadowOpacity);
  });

  test('each level carries an Android elevation value too', () => {
    expect(elevation.level1.androidElevation).toBeGreaterThan(elevation.level0.androidElevation);
    expect(elevation.level2.androidElevation).toBeGreaterThan(elevation.level1.androidElevation);
  });
});

describe('iconSize', () => {
  test('scale is ordered smallest to largest', () => {
    expect(iconSize.sm).toBeLessThan(iconSize.md);
    expect(iconSize.md).toBeLessThan(iconSize.lg);
  });
});

describe('spacing (existing)', () => {
  test('is preserved unchanged', () => {
    expect(spacing).toEqual({ xs: 4, sm: 8, md: 16, lg: 24, xl: 40 });
  });
});
