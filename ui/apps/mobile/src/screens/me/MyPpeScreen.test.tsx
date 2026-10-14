import { statusChipPalette } from '@boxalarm/design-tokens';
import { render } from '@testing-library/react-native';
import { MyPpeScreen } from './MyPpeScreen';

jest.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ memberId: 'MBR-0012' }),
  useOptionalAuth: () => undefined,
}));

test('every assigned PPE item is visible without officer help, expired items styled distinctly (AC4, AC3)', async () => {
  const { findByText } = await render(<MyPpeScreen />);

  const current = await findByText(/turnout_coat/);
  expect(current).toBeTruthy();
  expect(await findByText('expires 2024-01-15')).toBeTruthy();

  // The status is a chip: an expired item's is the danger pair, unlike an issued item's.
  const expiredLabel = await findByText('Expired');
  expect(expiredLabel).toHaveStyle({ color: statusChipPalette.day.danger.onFill });
  expect(await findByText('Issued')).toHaveStyle({ color: statusChipPalette.day.ok.onFill });
});
