import { palette } from '@boxalarm/design-tokens';
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

  const expiredLabel = await findByText(/EXPIRED · expires/);
  expect(expiredLabel).toHaveStyle({ color: palette.day.error });
});
