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

test('the VERIFY banner is an alert naming what to do', () => {
  render(<VerifyBanner />);
  expect(screen.getByRole('alert').textContent).toContain('confirm it by radio');
});
