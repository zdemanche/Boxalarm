import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { PrePlanPanel } from './PrePlanPanel';

afterEach(cleanup);

test('renders the matched pre-plan: summary, hazards, shut-offs and nearest hydrants with distance and flow class', () => {
  render(
    <PrePlanPanel
      prePlan={{
        summary: 'Multi family — 123 Main Street',
        hazards: ['LPG tank rear'],
        utilityShutoffs: [{ utility: 'Gas', location: 'Rear exterior wall' }],
        nearestHydrants: [
          {
            hydrantId: 'H-90',
            status: 'IN_SERVICE',
            distanceMeters: 90,
            size: '6-inch',
            flowRatingGpm: 1600,
            flowClass: 'AA',
          },
          { hydrantId: 'H-210', distanceMeters: 210 },
        ],
      }}
    />,
  );

  expect(screen.getByText('Multi family — 123 Main Street')).toBeTruthy();
  expect(screen.getByText('LPG tank rear')).toBeTruthy();
  expect(screen.getByText('Gas: Rear exterior wall')).toBeTruthy();
  const hydrants = screen
    .getAllByRole('listitem')
    .slice(-2)
    .map((li) => li.textContent);
  expect(hydrants).toEqual(['H-90 · 90 m · 6-inch · 1600 gpm (class AA)', 'H-210 · 210 m']);
});

test('still renders a hydrant from an older response with no distance or class', () => {
  render(
    <PrePlanPanel
      prePlan={{
        hazards: [],
        utilityShutoffs: [],
        nearestHydrants: [{ hydrantId: 'H-014', size: '4"', flowRatingGpm: 1000 }],
      }}
    />,
  );
  expect(screen.getByText('H-014 · 4" · 1000 gpm')).toBeTruthy();
});

test('says so when no pre-plan is on file for the address', () => {
  render(<PrePlanPanel prePlan={null} />);
  expect(screen.getByText('No pre-plan on file for this address.')).toBeTruthy();
});
