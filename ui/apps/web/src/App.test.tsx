import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { App } from './App';

beforeEach(() => {
  vi.stubEnv('COGNITO_ISSUER', 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test');
  vi.stubEnv('COGNITO_WEB_CLIENT_ID', 'test-web-client');
});

test('unauthenticated root route renders the sign-in screen with no MFA challenge', async () => {
  render(<App />);

  await screen.findByRole('button', { name: 'Sign in' });
  expect(screen.queryByText(/mfa/i)).toBeNull();
});
