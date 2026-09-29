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

test('says no pre-plan matched when none did', () => {
  render(<PrePlanPanel prePlan={null} />);
  expect(screen.getByText('No pre-plan matched this address.')).toBeTruthy();
});

test('says the pre-plan is unavailable - never "none" - when the lookup failed (minor 4)', () => {
  render(<PrePlanPanel prePlan={undefined} unavailable />);
  expect(screen.getByRole('note').textContent).toBe(
    'Pre-plan unavailable right now. This does not mean there is no pre-plan for this address.',
  );
  expect(screen.queryByText(/No pre-plan matched/)).toBeNull();
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

test('labels an out-of-service hydrant in text ("OUT OF SERVICE"), not by colour alone', () => {
  render(
    <PrePlanPanel
      prePlan={{
        ...BASE,
        nearestHydrants: [
          { hydrantId: 'H-15', status: 'OUT_OF_SERVICE', distanceMeters: 15 },
          { hydrantId: 'H-210', status: 'IN_SERVICE', distanceMeters: 210 },
        ],
      }}
    />,
  );
  const oos = screen.getByText('H-15 · 15 m · OUT OF SERVICE');
  expect(oos.style.fontWeight).toBe('700');
  expect(screen.getByText('H-210 · 210 m').style.fontWeight).toBe('');
});

test('shows the nearest hydrants even when no pre-plan matched (minor 5)', () => {
  render(
    <PrePlanPanel
      prePlan={null}
      nearestHydrants={[{ hydrantId: 'H-40', status: 'IN_SERVICE', distanceMeters: 40 }]}
    />,
  );
  expect(screen.getByText('No pre-plan matched this address.')).toBeTruthy();
  expect(screen.getByRole('list', { name: 'Nearest hydrants' }).textContent).toBe('H-40 · 40 m');
});

test('prefers the top-level hydrant list (with flagged OOS) over the legacy per-plan list', () => {
  render(
    <PrePlanPanel
      prePlan={{ ...BASE, nearestHydrants: [{ hydrantId: 'H-80', distanceMeters: 80 }] }}
      nearestHydrants={[
        { hydrantId: 'H-15', status: 'OUT_OF_SERVICE', distanceMeters: 15 },
        { hydrantId: 'H-80', status: 'IN_SERVICE', distanceMeters: 80 },
      ]}
    />,
  );
  const items = screen.getByRole('list', { name: 'Nearest hydrants' }).querySelectorAll('li');
  expect([...items].map((li) => li.textContent)).toEqual([
    'H-15 · 15 m · OUT OF SERVICE',
    'H-80 · 80 m',
  ]);
});

test('says the hydrant list is unavailable when that read failed', () => {
  render(<PrePlanPanel prePlan={null} hydrantsUnavailable />);
  expect(screen.getByRole('note').textContent).toBe('Hydrant list unavailable right now.');
});

test('warns when the hydrant list may be incomplete (server read hit its cap)', () => {
  render(
    <PrePlanPanel prePlan={null} nearestHydrants={[{ hydrantId: 'H-1' }]} hydrantsIncomplete />,
  );
  expect(screen.getByRole('note').textContent).toBe(
    'Hydrant list may be incomplete: a nearer hydrant may be missing.',
  );
});
