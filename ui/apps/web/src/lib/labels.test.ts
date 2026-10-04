import { expect, test } from 'vitest';
import { humanize } from './labels';

test('known enums read as words, unknown codes as sentence case', () => {
  expect(humanize('PARTIALLY_FILLED')).toBe('Partially filled');
  expect(humanize('turnout_coat')).toBe('Turnout coat');
  expect(humanize('LOA')).toBe('Leave of absence');
  expect(humanize('DRIVER_OPERATOR')).toBe('Driver operator');
  expect(humanize('')).toBe('');
});
