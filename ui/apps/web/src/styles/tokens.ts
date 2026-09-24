import {
  breakpoints,
  fontStack,
  motion,
  palette,
  radius,
  radiusScale,
  spacing,
  spacingScale,
  statusChipPalette,
  statusPalette,
  surfacePalette,
  targetSize,
  typeScale,
  typography,
} from '@boxalarm/design-tokens';

function typeVars(prefix: string, scale: typeof typeScale) {
  return Object.entries(scale)
    .map(
      ([name, step]) => `  --boxalarm-type-${prefix}${name}-size: ${step.size}px;
  --boxalarm-type-${prefix}${name}-lh: ${step.lineHeight}px;
  --boxalarm-type-${prefix}${name}-weight: ${step.weight};`,
    )
    .join('\n');
}

function surfaceVars(theme: 'day' | 'cab') {
  const s = surfacePalette[theme];
  const status = statusPalette[theme];
  const chip = statusChipPalette[theme];
  const chipVars = Object.entries(chip)
    .map(
      ([role, { fill, onFill }]) =>
        `  --bx-chip-fill-${role}: ${fill};\n  --bx-chip-onfill-${role}: ${onFill};`,
    )
    .join('\n');
  return `  --bx-bg: ${s.bg};
  --bx-surface: ${s.surface};
  --bx-surface-raised: ${s.surfaceRaised};
  --bx-fg: ${s.fg};
  --bx-fg-muted: ${s.fgMuted};
  --bx-fg-faint: ${s.fgFaint};
  --bx-border: ${s.border};
  --bx-border-strong: ${s.borderStrong};
  --bx-border-decorative: ${s.borderDecorative};
  --bx-focus: ${s.focus};
  --bx-focus-gap: ${s.focusGap};
  --bx-scrim: ${s.scrim};
  --bx-skeleton: ${s.skeleton};
  --bx-status-danger: ${status.danger};
  --bx-status-warning: ${status.warning};
  --bx-status-caution: ${status.caution};
  --bx-status-ok: ${status.ok};
  --bx-status-info: ${status.info};
  --bx-status-neutral: ${status.neutral};
${chipVars}`;
}

// Generated from @boxalarm/design-tokens rather than hand-maintained, so it can never drift out
// of sync with the mobile app's values. Mounted once at the app root (GlobalTokensStyle) so
// every route reaches for a var(--bx-*) / var(--boxalarm-*) token instead of a literal value.
// `--boxalarm-*` names are the pre-existing aliases (kept for the routes not yet migrated onto
// the command-console primitives); `--bx-*` is the new "command console" token surface.
export const GLOBAL_TOKENS_CSS = `
:root[data-palette='day'],
:root {
${surfaceVars('day')}
}

:root {
  --bx-space-2xs: ${spacingScale['2xs']}px;
  --bx-space-xs: ${spacingScale.xs}px;
  --bx-space-sm: ${spacingScale.sm}px;
  --bx-space-md: ${spacingScale.md}px;
  --bx-space-lg: ${spacingScale.lg}px;
  --bx-space-xl: ${spacingScale.xl}px;
  --bx-space-2xl: ${spacingScale['2xl']}px;
  --bx-space-3xl: ${spacingScale['3xl']}px;

  --bx-radius-none: ${radiusScale.none}px;
  --bx-radius-sm: ${radiusScale.sm}px;
  --bx-radius-md: ${radiusScale.md}px;
  --bx-radius-lg: ${radiusScale.lg}px;
  --bx-radius-pill: ${radiusScale.pill}px;

  --bx-target-office: ${targetSize.office}px;
  --bx-target-field: ${targetSize.field}px;
  --bx-target-gap: ${targetSize.gap}px;

  --bx-duration-fast: ${motion.duration.fast}ms;
  --bx-duration-base: ${motion.duration.base}ms;
  --bx-duration-slow: ${motion.duration.slow}ms;
  --bx-ease-standard: ${motion.easing.standard};

  --bx-font-ui: ${fontStack.ui};
  --bx-font-mono: ${fontStack.mono};

  --bx-bp-sm: ${breakpoints.sm}px;
  --bx-bp-md: ${breakpoints.md}px;
  --bx-bp-lg: ${breakpoints.lg}px;
  --bx-bp-xl: ${breakpoints.xl}px;
  --bx-bp-2xl: ${breakpoints.xxl}px;

${typeVars('', typeScale)}

  /* Pre-existing aliases — used by routes not yet migrated onto the command-console tokens. */
  --boxalarm-bg-day: ${palette.day.background};
  --boxalarm-fg-day: ${palette.day.foreground};
  --boxalarm-accent-day: ${palette.day.accent};
  --boxalarm-error-day: ${palette.day.error};
  --boxalarm-success-day: ${palette.day.success};
  --boxalarm-warning-day: ${palette.day.warning};

  --boxalarm-bg-cab: ${palette.cab.background};
  --boxalarm-fg-cab: ${palette.cab.foreground};
  --boxalarm-accent-cab: ${palette.cab.accent};
  --boxalarm-error-cab: ${palette.cab.error};
  --boxalarm-success-cab: ${palette.cab.success};
  --boxalarm-warning-cab: ${palette.cab.warning};

  --boxalarm-bg: var(--boxalarm-bg-day);
  --boxalarm-fg: var(--boxalarm-fg-day);
  --boxalarm-accent: var(--boxalarm-accent-day);
  --boxalarm-error: var(--boxalarm-error-day);
  --boxalarm-success: var(--boxalarm-success-day);
  --boxalarm-warning: var(--boxalarm-warning-day);

  --boxalarm-spacing-xs: ${spacing.xs}px;
  --boxalarm-spacing-sm: ${spacing.sm}px;
  --boxalarm-spacing-md: ${spacing.md}px;
  --boxalarm-spacing-lg: ${spacing.lg}px;
  --boxalarm-spacing-xl: ${spacing.xl}px;

  --boxalarm-radius-default: ${radius.default}px;
  --boxalarm-radius-card: ${radius.card}px;

  --boxalarm-font-size-xs: ${typography.size.xs}px;
  --boxalarm-font-size-sm: ${typography.size.sm}px;
  --boxalarm-font-size-base: ${typography.size.base}px;
  --boxalarm-font-size-lg: ${typography.size.lg}px;
  --boxalarm-font-size-xl: ${typography.size.xl}px;
  --boxalarm-font-size-xxl: ${typography.size.xxl}px;
  --boxalarm-font-size-display: ${typography.size.display}px;
  --boxalarm-line-height: ${typography.lineHeight};
}

@media (prefers-color-scheme: dark) {
  :root:not([data-palette]) {
${surfaceVars('cab')}
    --boxalarm-bg: var(--boxalarm-bg-cab);
    --boxalarm-fg: var(--boxalarm-fg-cab);
    --boxalarm-accent: var(--boxalarm-accent-cab);
    --boxalarm-error: var(--boxalarm-error-cab);
    --boxalarm-success: var(--boxalarm-success-cab);
    --boxalarm-warning: var(--boxalarm-warning-cab);
  }
}

:root[data-palette='cab'] {
${surfaceVars('cab')}
  --boxalarm-bg: var(--boxalarm-bg-cab);
  --boxalarm-fg: var(--boxalarm-fg-cab);
  --boxalarm-accent: var(--boxalarm-accent-cab);
  --boxalarm-error: var(--boxalarm-error-cab);
  --boxalarm-success: var(--boxalarm-success-cab);
  --boxalarm-warning: var(--boxalarm-warning-cab);
}

* {
  box-sizing: border-box;
}

body {
  background: var(--bx-bg);
  color: var(--bx-fg);
  margin: 0;
  line-height: var(--boxalarm-line-height);
  font-family: var(--bx-font-ui);
  -webkit-font-smoothing: antialiased;
}

::selection {
  background: var(--bx-focus);
  color: var(--bx-bg);
}

:focus-visible {
  outline: 3px solid var(--bx-focus);
  outline-offset: 2px;
  border-radius: var(--bx-radius-sm);
}

.skip-to-content {
  position: absolute;
  left: -10000px;
  top: auto;
  width: 1px;
  height: 1px;
  overflow: hidden;
}

.skip-to-content:focus {
  position: fixed;
  top: var(--bx-space-sm);
  left: var(--bx-space-sm);
  width: auto;
  height: auto;
  overflow: visible;
  padding: var(--bx-space-sm) var(--bx-space-md);
  background: var(--bx-fg);
  color: var(--bx-bg);
  border-radius: var(--bx-radius-md);
  z-index: 1000;
  font-weight: 600;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}
`;
