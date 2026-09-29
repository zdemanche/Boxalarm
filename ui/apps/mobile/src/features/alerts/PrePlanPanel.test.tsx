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

test('says so when no pre-plan is on file for the address', async () => {
  const { findByText } = await render(<PrePlanPanel prePlan={null} />);
  expect(await findByText('No pre-plan on file for this address.')).toBeTruthy();
});
