import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Trigger({ message = 'Riding assignment saved.' }: { message?: string }) {
  const { showToast } = useToast();
  return (
    <button type="button" onClick={() => showToast(message, 'ok')}>
      Save
    </button>
  );
}

function renderWithProvider(message?: string) {
  return render(
    <ToastProvider>
      <Trigger message={message} />
    </ToastProvider>,
  );
}

describe('Toast', () => {
  test('useToast throws outside ToastProvider', () => {
    // Suppress React's expected console.error for this render-time throw.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Bare() {
      useToast();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/useToast must be used within ToastProvider/);
    spy.mockRestore();
  });

  test('showToast renders the message in the role=status viewport', async () => {
    const user = userEvent.setup();
    renderWithProvider();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Riding assignment saved.');
  });

  test('the Dismiss button removes the toast immediately', async () => {
    const user = userEvent.setup();
    renderWithProvider();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Riding assignment saved.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Riding assignment saved.')).toBeNull();
  });

  test('auto-dismisses after 6s', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Riding assignment saved.')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByText('Riding assignment saved.')).toBeNull();
  });

  test('multiple toasts stack and can be dismissed independently', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger message="First" />
        <Trigger message="Second" />
      </ToastProvider>,
    );
    const [firstButton, secondButton] = screen.getAllByRole('button', { name: 'Save' });
    await user.click(firstButton!);
    await user.click(secondButton!);
    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.getByText('Second')).toBeTruthy();

    const dismissButtons = screen.getAllByRole('button', { name: 'Dismiss' });
    await user.click(dismissButtons[0]!);
    expect(screen.queryByText('First')).toBeNull();
    expect(screen.getByText('Second')).toBeTruthy();
  });

  // Stabilizes the API the README pointed consumers at ("a toast with an action") without
  // actually implementing it.
  test('an action calls its onClick and dismisses the toast', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    function UndoTrigger() {
      const { showToast } = useToast();
      return (
        <button
          type="button"
          onClick={() => showToast('Member removed.', 'default', { label: 'Undo', onClick })}
        >
          Remove
        </button>
      );
    }

    render(
      <ToastProvider>
        <UndoTrigger />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('Member removed.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Member removed.')).toBeNull();
  });

  test('a toast with no action renders no action button, only Dismiss', async () => {
    const user = userEvent.setup();
    renderWithProvider();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getAllByRole('button', { name: 'Dismiss' }).length).toBe(1);
    expect(screen.getByRole('status').querySelectorAll('button').length).toBe(1);
  });

  // Regression: the auto-dismiss timer used to be fired-and-forgotten, so dismissing a toast
  // early (or unmounting the provider) left a stale setTimeout that could later call setState on
  // an unmounted component. Manually dismissing must clear its timer, not just remove the toast.
  test('manually dismissing a toast clears its pending auto-dismiss timer', () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
