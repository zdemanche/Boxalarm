import { palette, radius, spacing, typography } from '@boxalarm/design-tokens';

// Generated from @boxalarm/design-tokens rather than hand-maintained, so it can never drift out
// of sync with the mobile app's values. Mounted once at the app root (GlobalTokensStyle) so the
// 15 web routes not built in this phase's scope inherit a consistent visual language once they
// are - each route reaches for var(--boxalarm-*) instead of re-declaring its own token values.
export const GLOBAL_TOKENS_CSS = `
:root {
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
  :root {
    --boxalarm-bg: var(--boxalarm-bg-cab);
    --boxalarm-fg: var(--boxalarm-fg-cab);
    --boxalarm-accent: var(--boxalarm-accent-cab);
    --boxalarm-error: var(--boxalarm-error-cab);
    --boxalarm-success: var(--boxalarm-success-cab);
    --boxalarm-warning: var(--boxalarm-warning-cab);
  }
}

body {
  background: var(--boxalarm-bg);
  color: var(--boxalarm-fg);
  margin: 0;
  line-height: var(--boxalarm-line-height);
  font-family:
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
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
  position: static;
  left: auto;
  width: auto;
  height: auto;
  overflow: visible;
  padding: var(--boxalarm-spacing-sm) var(--boxalarm-spacing-md);
  background: var(--boxalarm-accent);
  color: var(--boxalarm-bg);
  z-index: 1000;
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
`;
