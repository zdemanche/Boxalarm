import { render } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { AuthContextValue } from '../auth/AuthContext';
import { RequireRole } from './RequireRole';

const mockAuth: { current: AuthContextValue | undefined } = { current: undefined };
jest.mock('../auth/AuthContext', () => ({
  useOptionalAuth: () => mockAuth.current,
}));

function authWithRoles(roles: AuthContextValue['roles']): AuthContextValue {
  return {
    roles,
    memberId: 'MBR-TEST',
    isAuthenticated: true,
    isLoading: false,
    signIn: jest.fn(),
    signOut: jest.fn(),
    getAccessToken: jest.fn(),
    renewSilently: jest.fn(),
  };
}

beforeEach(() => {
  mockAuth.current = undefined;
});

test('renders children when the signed-in member has one of the required roles', async () => {
  mockAuth.current = authWithRoles(['OFFICER']);

  const { findByText } = await render(
    <RequireRole roles={['OFFICER', 'CHIEF']}>
      <Text>Protected content</Text>
    </RequireRole>,
  );

  expect(await findByText('Protected content')).toBeTruthy();
});

test('renders Forbidden, not the screen, when the signed-in member lacks the required role', async () => {
  mockAuth.current = authWithRoles(['MEMBER']);

  const { findByRole, queryByText } = await render(
    <RequireRole roles={['OFFICER', 'CHIEF']}>
      <Text>Protected content</Text>
    </RequireRole>,
  );

  expect(await findByRole('header', { name: 'Forbidden' })).toBeTruthy();
  expect(queryByText('Protected content')).toBeNull();
});

test('renders Forbidden when there is no signed-in member at all (e.g. a deep link before auth resolves)', async () => {
  mockAuth.current = undefined;

  const { findByRole, queryByText } = await render(
    <RequireRole roles={['OFFICER', 'CHIEF']}>
      <Text>Protected content</Text>
    </RequireRole>,
  );

  expect(await findByRole('header', { name: 'Forbidden' })).toBeTruthy();
  expect(queryByText('Protected content')).toBeNull();
});
