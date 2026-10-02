import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { DispatchUpdates, VerifyBanner } from './AlertsRosterPage';

afterEach(cleanup);

test('lists CAD updates oldest first with what changed', () => {
  render(
    <DispatchUpdates
      unavailable={false}
      updates={[
        {
          updateId: 'u1',
          receivedAt: 1_800_000_180,
          summary: 'Units: E1, L2, R1',
          changes: [
            { field: 'unitsRequested', from: 'E1, L2', to: 'E1, L2, R1' },
            { field: 'narrative', from: 'a', to: 'b' },
          ],
        },
      ]}
    />,
  );
  expect(screen.getByRole('heading', { name: 'CAD updates (1)' })).toBeTruthy();
  expect(screen.getByText('Units: E1, L2 → E1, L2, R1')).toBeTruthy();
  expect(screen.queryByText(/Narrative:/)).toBeNull();
});

test('says so when the history could not be loaded, and shows nothing when there is none', () => {
  const { rerender } = render(<DispatchUpdates unavailable updates={undefined} />);
  expect(screen.getByRole('status').textContent).toContain('could not be loaded');
  rerender(<DispatchUpdates unavailable={false} updates={[]} />);
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('heading')).toBeNull();
});

test("an update from another day shows its date; today's shows the time only", () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  render(
    <DispatchUpdates
      unavailable={false}
      updates={[
        {
          updateId: 'u-yesterday',
          receivedAt: nowSeconds - 24 * 60 * 60,
          summary: 'First alarm',
          changes: [],
        },
        { updateId: 'u-today', receivedAt: nowSeconds, summary: 'Second alarm', changes: [] },
      ]}
    />,
  );
  const [first, second] = screen.getAllByRole('listitem');
  const dayName = yesterday.toLocaleString(undefined, { month: 'short', day: 'numeric' });
  expect(first!.textContent).toContain(dayName);
  expect(second!.textContent).not.toContain(
    new Date().toLocaleString(undefined, { month: 'short' }),
  );
});

test('the VERIFY banner is an alert naming what to do', () => {
  render(<VerifyBanner />);
  expect(screen.getByRole('alert').textContent).toContain('confirm it by radio');
});
