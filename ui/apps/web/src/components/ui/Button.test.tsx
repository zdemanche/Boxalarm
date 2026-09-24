import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Button, IconButton } from './Button';
import { Settings } from './icons';

afterEach(cleanup);

describe('Button', () => {
  test('renders its label and responds to a click', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save check</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Save check' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('loading: keeps the button focusable and does not set the native disabled attribute', () => {
    // Regression for MAJOR-5: setting `disabled` while `loading` moves focus to <body> on
    // submit, stranding keyboard/screen-reader users (docs/a11y-spec.md:367).
    render(<Button loading>Create apparatus</Button>);
    const button = screen.getByRole('button', { name: 'Create apparatus' });
    expect(button.getAttribute('disabled')).toBeNull();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  test('loading: a focused button stays focused across the loading transition', () => {
    const { rerender } = render(<Button>Create apparatus</Button>);
    const button = screen.getByRole('button', { name: 'Create apparatus' });
    button.focus();
    expect(document.activeElement).toBe(button);

    rerender(<Button loading>Create apparatus</Button>);
    expect(document.activeElement).toBe(button);
  });

  test('loading: click activation is a no-op (never fires onClick, never submits the form)', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Create apparatus
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create apparatus' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  test('explicit disabled still sets the native disabled attribute (unchanged behaviour)', () => {
    render(<Button disabled>Create apparatus</Button>);
    expect(
      screen.getByRole('button', { name: 'Create apparatus' }).getAttribute('disabled'),
    ).not.toBeNull();
  });
});

describe('IconButton', () => {
  test('uses the label as the accessible name', () => {
    render(<IconButton icon={Settings} label="Open settings" onClick={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeTruthy();
  });
});
