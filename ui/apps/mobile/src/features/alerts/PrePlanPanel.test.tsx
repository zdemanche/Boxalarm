import { render } from '@testing-library/react-native';
import { PrePlanPanel } from './PrePlanPanel';

test('renders the matched pre-plan with nearest hydrants, distance and flow class', async () => {
  const { findByText } = await render(
    <PrePlanPanel
      prePlan={{
        summary: 'Multi family — 123 Main Street',
        hazards: ['LPG tank rear'],
        utilityShutoffs: [{ utility: 'Gas', location: 'Rear exterior wall' }],
        nearestHydrants: [
          {
            hydrantId: 'H-90',
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

  expect(await findByText('Multi family — 123 Main Street')).toBeTruthy();
  expect(await findByText('LPG tank rear')).toBeTruthy();
  expect(await findByText('Gas: Rear exterior wall')).toBeTruthy();
  expect(await findByText('H-90 · 90 m · 6-inch · 1600 gpm (class AA)')).toBeTruthy();
  expect(await findByText('H-210 · 210 m')).toBeTruthy();
});

test('says no pre-plan matched when none did', async () => {
  const { findByText } = await render(<PrePlanPanel prePlan={null} />);
  expect(await findByText('No pre-plan matched this address.')).toBeTruthy();
});

test('announces the pre-plan as unavailable - never "none" - when the lookup failed', async () => {
  const { findByRole, queryByText } = await render(
    <PrePlanPanel prePlan={undefined} unavailable />,
  );
  expect((await findByRole('alert')).props.children).toBe(
    'Pre-plan unavailable right now. This does not mean there is no pre-plan for this address.',
  );
  expect(queryByText(/No pre-plan matched/)).toBeNull();
});

const BASE = { hazards: [], utilityShutoffs: [], nearestHydrants: [] };

test('shows the matched address plainly for an exact address match', async () => {
  const { findByText, queryByText } = await render(
    <PrePlanPanel
      prePlan={{ ...BASE, matchType: 'ADDRESS', matchedAddress: '123 Main Street', unit: null }}
    />,
  );
  expect(await findByText('Pre-plan for 123 Main Street')).toBeTruthy();
  expect(queryByText(/VERIFY ADDRESS/)).toBeNull();
});

test('announces a NEARBY match as an alert that says to verify the address', async () => {
  const { findByRole } = await render(
    <PrePlanPanel
      prePlan={{ ...BASE, matchType: 'NEARBY', matchedAddress: '12 Main St', distanceMeters: 30 }}
    />,
  );
  const alert = await findByRole('alert');
  expect(alert.props.children).toBe(
    'VERIFY ADDRESS: nearby pre-plan for 12 Main St, 30 m from the dispatch location.',
  );
});

test('flags UNIT_MISMATCH as a VERIFY ADDRESS notice naming the other unit', async () => {
  const mismatch = await render(
    <PrePlanPanel
      prePlan={{ ...BASE, matchType: 'UNIT_MISMATCH', matchedAddress: '40 Oak Ave', unit: '2' }}
    />,
  );
  expect(
    await mismatch.findByText(
      'VERIFY ADDRESS: this pre-plan is for 40 Oak Ave (unit 2), a different unit than dispatched.',
    ),
  ).toBeTruthy();
});

test('lists CANDIDATES with their units and hazards under a VERIFY ADDRESS notice', async () => {
  const { findByText } = await render(
    <PrePlanPanel
      prePlan={{
        ...BASE,
        matchType: 'CANDIDATES',
        candidates: [
          {
            occupancyId: 'A',
            matchedAddress: '123 Main St',
            unit: 'A',
            hazards: [],
            utilityShutoffs: [],
          },
          {
            occupancyId: 'B',
            matchedAddress: '123 Main St',
            unit: 'B',
            hazards: ['Chlorine'],
            utilityShutoffs: [],
          },
        ],
      }}
    />,
  );
  expect(
    await findByText('VERIFY ADDRESS: 2 pre-plans match this address. Confirm which one applies.'),
  ).toBeTruthy();
  expect(await findByText('123 Main St (unit A)')).toBeTruthy();
  expect(await findByText('Chlorine')).toBeTruthy();
});

test('labels an out-of-service hydrant "OUT OF SERVICE" in text and in the error colour', async () => {
  const { findByText } = await render(
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
  const oos = await findByText('H-15 · 15 m · OUT OF SERVICE');
  expect(oos.props.style).toMatchObject({ fontWeight: '700' });
  expect(await findByText('H-210 · 210 m')).toBeTruthy();
});
