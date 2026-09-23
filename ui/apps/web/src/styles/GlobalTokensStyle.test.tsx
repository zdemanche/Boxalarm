import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { GlobalTokensStyle } from './GlobalTokensStyle';
import { GLOBAL_TOKENS_CSS } from './tokens';

test('mounts the generated token CSS as a style tag', () => {
  const { container } = render(<GlobalTokensStyle />);
  const style = container.querySelector('style');

  expect(style).not.toBeNull();
  expect(style!.textContent).toBe(GLOBAL_TOKENS_CSS);
});
