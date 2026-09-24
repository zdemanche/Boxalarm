import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConfirmDialog, Dialog } from './Dialog';

afterEach(cleanup);

describe('Dialog', () => {
  test('renders nothing when closed, and its title/content when open', () => {
    const { rerender } = render(
      <Dialog open={false} onOpenChange={() => undefined} title="Add apparatus">
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    rerender(
      <Dialog open onOpenChange={() => undefined} title="Add apparatus">
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.getByRole('dialog', { name: 'Add apparatus' })).toBeTruthy();
    expect(screen.getByText('Body')).toBeTruthy();
  });

  test('Escape calls onOpenChange(false)', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange} title="Add apparatus">
        <p>Body</p>
      </Dialog>,
    );
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('ConfirmDialog', () => {
  test('Cancel calls onOpenChange(false) without calling onConfirm', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Place Engine 301 out of service?"
        consequence="It will be removed from riding assignments."
        confirmLabel="Place out of service"
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('confirming calls onConfirm then closes', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Place Engine 301 out of service?"
        consequence="It will be removed from riding assignments."
        confirmLabel="Place out of service"
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Place out of service' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('Cancel is the default focused control (non-destructive default)', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Place Engine 301 out of service?"
        consequence="It will be removed from riding assignments."
        confirmLabel="Place out of service"
        onConfirm={() => undefined}
        danger
      />,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  test('async onConfirm: shows a busy confirm button, disables Cancel, and closes on success', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { promise, resolve } = deferred<void>();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Place Engine 301 out of service?"
        consequence="It will be removed from riding assignments."
        confirmLabel="Place out of service"
        onConfirm={() => promise}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Place out of service' }));
    const confirmButton = screen.getByRole('button', { name: 'Place out of service' });
    expect(confirmButton.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('button', { name: 'Cancel' }).getAttribute('disabled')).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();

    resolve();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  test('async onConfirm: a rejection keeps the dialog open and shows the error inline', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { promise, reject } = deferred<void>();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Place Engine 301 out of service?"
        consequence="It will be removed from riding assignments."
        confirmLabel="Place out of service"
        onConfirm={() => promise}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Place out of service' }));
    reject(new Error('Network unreachable.'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Network unreachable.'));

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // Pending has cleared, so the confirm button is no longer busy and Cancel works again.
    expect(
      screen.getByRole('button', { name: 'Place out of service' }).getAttribute('aria-busy'),
    ).toBeNull();
  });
});
