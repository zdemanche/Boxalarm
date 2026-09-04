import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { spacing } from '@boxalarm/design-tokens';
import { App } from './App';

test('placeholder route renders and consumes shared design tokens', () => {
  render(<App />);

  screen.getByRole('heading', { level: 1, name: 'Boxalarm' });
  expect(screen.getByRole('main').style.padding).toBe(`${spacing.lg}px`);
});
