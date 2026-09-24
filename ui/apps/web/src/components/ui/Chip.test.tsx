import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Badge, StatusChip } from './Chip';

afterEach(cleanup);

describe('StatusChip', () => {
  test('renders the glyph, the word, and data-status for each role', () => {
    render(<StatusChip status="danger">Out of service</StatusChip>);
    const chip = screen.getByText('Out of service');
    expect(chip.getAttribute('data-status')).toBe('danger');
  });

  // Regression for MAJOR-6: the fill/label pair used to be the status hue on a
  // color-mix(status, transparent) tint, whose rendered contrast depended on whatever surface
  // the chip sat on and measured below AA on Cards and hovered DataTable rows. The fix draws an
  // opaque fill/onFill pair from --bx-chip-fill-*/--bx-chip-onfill-* (design-tokens'
  // statusChipPalette, verified AA in index.test.ts) instead, so contrast can't drift with
  // placement.
  test.each(['ok', 'danger', 'warning', 'caution', 'info', 'neutral'] as const)(
    '%s status uses the opaque chip fill/onFill tokens, not a translucent status-colour tint',
    (status) => {
      render(<StatusChip status={status}>Status</StatusChip>);
      const chip = screen.getByText('Status');
      expect(chip.style.background).toBe(`var(--bx-chip-fill-${status})`);
      expect(chip.style.color).toBe(`var(--bx-chip-onfill-${status})`);
      expect(chip.style.background).not.toContain('color-mix');
    },
  );

  test('an explicit style prop can still override the computed fill/label', () => {
    render(
      <StatusChip status="ok" style={{ color: 'red' }}>
        Custom
      </StatusChip>,
    );
    expect(screen.getByText('Custom').style.color).toBe('red');
  });
});

describe('Badge', () => {
  test('renders its children', () => {
    render(<Badge>Probationary</Badge>);
    expect(screen.getByText('Probationary')).toBeTruthy();
  });
});
