import { palette, radius, spacing, typography } from '@boxalarm/design-tokens';
import { expect, test } from 'vitest';
import { GLOBAL_TOKENS_CSS } from './tokens';

// The 15 web routes beyond sign-in/landing aren't built in this phase's scope, but they need a
// consistent visual language to inherit once they are - this CSS is generated straight from
// @boxalarm/design-tokens so it can never drift out of sync with the mobile app's values.
test('declares both palettes as custom properties, generated from the tokens package', () => {
  expect(GLOBAL_TOKENS_CSS).toContain(`--boxalarm-bg-day: ${palette.day.background};`);
  expect(GLOBAL_TOKENS_CSS).toContain(`--boxalarm-accent-day: ${palette.day.accent};`);
  expect(GLOBAL_TOKENS_CSS).toContain(`--boxalarm-bg-cab: ${palette.cab.background};`);
  expect(GLOBAL_TOKENS_CSS).toContain(`--boxalarm-accent-cab: ${palette.cab.accent};`);
});

test('remaps the generic vars to the cab palette under prefers-color-scheme: dark', () => {
  expect(GLOBAL_TOKENS_CSS).toContain('@media (prefers-color-scheme: dark)');
  const darkBlock = GLOBAL_TOKENS_CSS.split('@media (prefers-color-scheme: dark)')[1];
  expect(darkBlock).toContain('--boxalarm-bg: var(--boxalarm-bg-cab);');
  expect(darkBlock).toContain('--boxalarm-accent: var(--boxalarm-accent-cab);');
});

test('declares spacing, radius, and typography scale as custom properties', () => {
  expect(GLOBAL_TOKENS_CSS).toContain(`--boxalarm-spacing-lg: ${spacing.lg}px;`);
  expect(GLOBAL_TOKENS_CSS).toContain(`--boxalarm-radius-default: ${radius.default}px;`);
  expect(GLOBAL_TOKENS_CSS).toContain(`--boxalarm-font-size-base: ${typography.size.base}px;`);
});
