import { describe, expect, test } from 'vitest';
import { meetsAA } from './contrast';
import {
  accentPalette,
  breakpoints,
  palette,
  radius,
  radiusScale,
  shellPalette,
  spacing,
  spacingScale,
  statusChipPalette,
  statusPalette,
  surfacePalette,
  targetSize,
  touchTarget,
  typeScale,
  fieldTypeScale,
  typography,
} from './index';

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

describe('spacing (existing)', () => {
  test('is preserved unchanged', () => {
    expect(spacing).toEqual({ xs: 4, sm: 8, md: 16, lg: 24, xl: 40 });
  });
});

describe('surfacePalette', () => {
  test.each(['day', 'cab'] as const)(
    '%s: fg/fgMuted/fgFaint clear normal-text AA on bg',
    (name) => {
      const { bg, fg, fgMuted, fgFaint } = surfacePalette[name];
      expect(meetsAA(bg, fg, 'normal')).toBe(true);
      expect(meetsAA(bg, fgMuted, 'normal')).toBe(true);
      expect(meetsAA(bg, fgFaint, 'normal')).toBe(true);
    },
  );

  test.each(['day', 'cab'] as const)(
    '%s: fg/fgMuted clear normal-text AA on the raised surface',
    (name) => {
      const { surfaceRaised, fg, fgMuted } = surfacePalette[name];
      expect(meetsAA(surfaceRaised, fg, 'normal')).toBe(true);
      expect(meetsAA(surfaceRaised, fgMuted, 'normal')).toBe(true);
    },
  );

  test.each(['day', 'cab'] as const)('%s: border clears non-text AA (3:1) on bg', (name) => {
    const { bg, border, borderStrong } = surfacePalette[name];
    expect(meetsAA(bg, border, 'large')).toBe(true);
    expect(meetsAA(bg, borderStrong, 'large')).toBe(true);
  });

  test.each(['day', 'cab'] as const)('%s: focus ring clears non-text AA (3:1) on bg', (name) => {
    const { bg, focus } = surfacePalette[name];
    expect(meetsAA(bg, focus, 'large')).toBe(true);
  });

  // Links sit inside cards and table rows as often as on the page ground, so they must clear
  // normal-text AA on every surface step, not just bg.
  test.each(['day', 'cab'] as const)(
    '%s: link clears normal-text AA on bg, surface and the raised surface',
    (name) => {
      const { bg, surface, surfaceRaised, link } = surfacePalette[name];
      expect(meetsAA(bg, link, 'normal')).toBe(true);
      expect(meetsAA(surface, link, 'normal')).toBe(true);
      expect(meetsAA(surfaceRaised, link, 'normal')).toBe(true);
    },
  );
});

describe('statusPalette', () => {
  test.each(['day', 'cab'] as const)(
    '%s: every status role clears normal-text AA on bg',
    (name) => {
      const { bg } = surfacePalette[name];
      const roles = statusPalette[name];
      for (const hex of Object.values(roles)) {
        expect(meetsAA(bg, hex, 'normal')).toBe(true);
      }
    },
  );

  test.each(['day', 'cab'] as const)(
    '%s: every status role clears normal-text AA on the base surface',
    (name) => {
      const { surface } = surfacePalette[name];
      const roles = statusPalette[name];
      for (const hex of Object.values(roles)) {
        expect(meetsAA(surface, hex, 'normal')).toBe(true);
      }
    },
  );
});

describe('statusChipPalette', () => {
  // Regression for MAJOR-6: StatusChip previously drew status-hue text on a
  // color-mix(status, transparent) background composited over whatever surface it sat on, which
  // measured as low as 4.14:1 on a hovered DataTable row (day danger) - below the 4.5:1 AA floor
  // for the chip's 12px/600 label text, despite the "AA by construction" claim. These fills are
  // fully opaque, chosen from a11y-spec.md §1.2's approved chip table, so label:fill contrast is
  // fixed and holds no matter what's behind the chip (Card, hovered row, Dialog).
  test.each(['day', 'cab'] as const)(
    '%s: every role clears normal-text AA for label on its own (opaque) fill',
    (name) => {
      const roles = statusChipPalette[name];
      for (const { fill, onFill } of Object.values(roles)) {
        expect(meetsAA(fill, onFill, 'normal')).toBe(true);
      }
    },
  );

  // Since the 2026-10-11 redesign the chip's border is a soft tint of its label, drawn for looks;
  // a chip is not a control, so it needs no 3:1 boundary. Status is carried by the label, the
  // glyph and the word, all on the opaque fill tested above.
});

describe('typeScale', () => {
  test('is ordered smallest to largest by size', () => {
    const { caption, bodyDense, body, subheading, heading, title, display } = typeScale;
    expect(bodyDense.size).toBeGreaterThanOrEqual(caption.size);
    expect(body.size).toBeGreaterThanOrEqual(bodyDense.size);
    expect(subheading.size).toBeGreaterThanOrEqual(body.size);
    expect(heading.size).toBeGreaterThan(subheading.size);
    expect(title.size).toBeGreaterThan(heading.size);
    expect(display.size).toBeGreaterThan(title.size);
  });

  test('no size is below 12px (docs/design.md §2.4)', () => {
    for (const step of Object.values(typeScale)) {
      expect(step.size).toBeGreaterThanOrEqual(12);
    }
  });
});

describe('fieldTypeScale', () => {
  test('matches docs/design.md §2.4 field scale', () => {
    expect(fieldTypeScale.address.size).toBe(32);
    expect(fieldTypeScale.title.size).toBe(24);
    expect(fieldTypeScale.heading.size).toBe(20);
    expect(fieldTypeScale.body.size).toBe(17);
    expect(fieldTypeScale.label.size).toBe(15);
    expect(fieldTypeScale.caption.size).toBe(13);
  });

  test('body is at least 16 and no step is below 13 (docs/a11y-spec.md §1.1)', () => {
    expect(fieldTypeScale.body.size).toBeGreaterThanOrEqual(16);
    for (const step of Object.values(fieldTypeScale)) {
      expect(step.size).toBeGreaterThanOrEqual(13);
    }
  });
});

describe('targetSize', () => {
  test('carries the alert floor and field gap (docs/a11y-spec.md §1.1)', () => {
    expect(targetSize.alert).toBe(72);
    expect(targetSize.alert).toBeGreaterThan(targetSize.field);
    expect(targetSize.fieldGap).toBe(12);
  });
});

describe('spacingScale', () => {
  test('extends the existing spacing steps without changing them', () => {
    expect(spacingScale.xs).toBe(spacing.xs);
    expect(spacingScale.sm).toBe(spacing.sm);
    expect(spacingScale.md).toBe(spacing.md);
    expect(spacingScale.lg).toBe(spacing.lg);
    expect(spacingScale.xl).toBe(spacing.xl);
  });

  test('is ordered smallest to largest', () => {
    const values = Object.values(spacingScale);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    }
  });
});

describe('radiusScale', () => {
  test('is ordered smallest to largest', () => {
    expect(radiusScale.sm).toBeGreaterThan(radiusScale.none);
    expect(radiusScale.md).toBeGreaterThan(radiusScale.sm);
    expect(radiusScale.lg).toBeGreaterThan(radiusScale.md);
    expect(radiusScale.pill).toBeGreaterThan(radiusScale.lg);
  });
});

describe('breakpoints', () => {
  test('is ordered smallest to largest', () => {
    const values = Object.values(breakpoints);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    }
  });
});

// 2026-10-11 web redesign: the amber brand accent (the mobile app's palette.accent) on buttons
// and selection, and a dark navigation shell in both palettes.
describe('accentPalette', () => {
  test.each(['day', 'cab'] as const)(
    '%s: text on the accent fill clears normal-text AA',
    (name) => {
      const { fill, fillHover, onFill } = accentPalette[name];
      expect(meetsAA(fill, onFill, 'normal')).toBe(true);
      expect(meetsAA(fillHover, onFill, 'normal')).toBe(true);
    },
  );

  // The web day card is surfacePalette.day.bg (white) and the cab card is cab.surface.
  test.each([
    ['day', surfacePalette.day.bg],
    ['cab', surfacePalette.cab.surface],
  ] as const)('%s: the text-safe accent clears normal-text AA on a card', (name, card) => {
    expect(meetsAA(card, accentPalette[name].accent, 'normal')).toBe(true);
  });

  test.each(['day', 'cab'] as const)('%s: subtle accent pair clears normal-text AA', (name) => {
    const { accentSubtle, onAccentSubtle } = accentPalette[name];
    expect(meetsAA(accentSubtle, onAccentSubtle, 'normal')).toBe(true);
  });

  test.each(['day', 'cab'] as const)(
    '%s: the accent is the mobile brand accent, so web and phone read as one product',
    (name) => {
      expect(accentPalette[name].accent).toBe(palette[name].accent);
    },
  );

  // Selected-state marks (active tab underline, current report step, checked box edge, unread
  // dot) are non-text and must clear 3:1 against the surface they sit on (WCAG 1.4.11). The bright
  // day fill measures ~2:1 on white, so marks use `indicator`. Web cards: day bg, cab surface;
  // web canvas: day surface, cab bg.
  test.each([
    ['day', [surfacePalette.day.bg, surfacePalette.day.surface]],
    ['cab', [surfacePalette.cab.surface, surfacePalette.cab.bg]],
  ] as const)(
    '%s: the selection indicator clears 3:1 on the card and the canvas',
    (name, grounds) => {
      for (const ground of grounds) {
        expect(meetsAA(ground, accentPalette[name].indicator, 'large')).toBe(true);
      }
    },
  );
});

describe('shellPalette', () => {
  test('nav text clears normal-text AA on the shell and on a hovered/selected item', () => {
    const { bg, bgRaised, fg, fgMuted } = shellPalette;
    for (const surface of [bg, bgRaised]) {
      expect(meetsAA(surface, fg, 'normal')).toBe(true);
      expect(meetsAA(surface, fgMuted, 'normal')).toBe(true);
    }
  });

  test('the selected-item marker clears non-text AA (3:1) on the shell', () => {
    expect(meetsAA(shellPalette.bgRaised, shellPalette.accent, 'large')).toBe(true);
  });
});
