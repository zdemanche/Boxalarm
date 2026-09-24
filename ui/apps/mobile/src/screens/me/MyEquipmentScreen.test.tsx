import { render } from '@testing-library/react-native';
import { MyEquipmentScreen } from './MyEquipmentScreen';

jest.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ memberId: 'MBR-0012' }),
  useOptionalAuth: () => undefined,
}));

test('lists equipment assigned to the signed-in member', async () => {
  const { findByText } = await render(<MyEquipmentScreen />);

  expect(await findByText('THERM-0092')).toBeTruthy();
  expect(await findByText(/Station 1/)).toBeTruthy();
});
