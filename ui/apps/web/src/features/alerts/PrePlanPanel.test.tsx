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

const BASE = { hazards: [], utilityShutoffs: [], nearestHydrants: [] };

test('always shows what the pre-plan was matched on, plainly for an exact address match', () => {
  render(
    <PrePlanPanel
      prePlan={{ ...BASE, matchType: 'ADDRESS', matchedAddress: '123 Main Street', unit: null }}
    />,
  );
  const line = screen.getByText('Pre-plan for 123 Main Street');
  expect(line.getAttribute('role')).toBeNull();
  expect(screen.queryByText(/VERIFY ADDRESS/)).toBeNull();
});

test.each([
  [
    'NEARBY',
    { matchType: 'NEARBY', matchedAddress: '12 Main St', distanceMeters: 30 },
    'VERIFY ADDRESS: nearby pre-plan for 12 Main St, 30 m from the dispatch location.',
  ],
  [
    'UNIT_MISMATCH',
    { matchType: 'UNIT_MISMATCH', matchedAddress: '40 Oak Ave', unit: '2' },
    'VERIFY ADDRESS: this pre-plan is for 40 Oak Ave (unit 2), a different unit than dispatched.',
  ],
] as const)('%s is a text warning ("VERIFY ADDRESS"), not colour alone', (_type, match, text) => {
  render(<PrePlanPanel prePlan={{ ...BASE, ...match }} />);
  const notice = screen.getByRole('note');
  expect(notice.textContent).toBe(text);
});

test('CANDIDATES lists every matching pre-plan with its unit and hazards under a warning', () => {
  render(
    <PrePlanPanel
      prePlan={{
        ...BASE,
        matchType: 'CANDIDATES',
        matchedAddress: '123 Main St Unit A',
        candidates: [
          {
            occupancyId: 'A',
            matchedAddress: '123 Main St',
            unit: 'A',
            summary: 'Bakery',
            hazards: [],
            utilityShutoffs: [],
          },
          {
            occupancyId: 'B',
            matchedAddress: '123 Main St',
            unit: 'B',
            summary: 'Pool chemicals',
            hazards: ['Chlorine'],
            utilityShutoffs: [],
          },
        ],
      }}
    />,
  );
  expect(screen.getByRole('note').textContent).toBe(
    'VERIFY ADDRESS: 2 pre-plans match this address. Confirm which one applies.',
  );
  const list = screen.getByRole('list', { name: 'Matching pre-plans' });
  expect(list.textContent).toContain('123 Main St (unit A)');
  expect(list.textContent).toContain('123 Main St (unit B)');
  expect(list.textContent).toContain('Chlorine');
});
