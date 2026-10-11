import type { ReactNode } from 'react';
import Config from 'react-native-config';
import { StaticAuthProvider, type AuthContextValue } from './AuthContext';

/**
 * DEMO_MODE=true in apps/mobile/.env runs the app signed in as a demo officer with no Cognito,
 * for the iOS Simulator and walkthroughs. Every data hook already serves its mock repository
 * when API_BASE_URL is unset, so the demo shows the mock department.
 *
 * Refused whenever API_BASE_URL is set: the demo session holds no tokens, and must never be
 * presented to a real backend.
 */
export function isDemoMode(
  config: { DEMO_MODE?: string; API_BASE_URL?: string } = Config,
): boolean {
  return config.DEMO_MODE === 'true' && !config.API_BASE_URL;
}

/** The mock repositories' member (mockMeRepository / mockAlertsRepository). */
const DEMO_MEMBER_ID = 'MBR-0012';

const DEMO_SESSION: AuthContextValue = {
  roles: ['MEMBER', 'OFFICER'],
  memberId: DEMO_MEMBER_ID,
  deptId: null,
  isAuthenticated: true,
  isLoading: false,
  signIn: () => Promise.resolve(),
  signOut: () => Promise.resolve({ pushRevoked: true }),
  getAccessToken: () => Promise.resolve(null),
  renewSilently: () => Promise.resolve(null),
};

export function DemoAuthProvider({ children }: { children: ReactNode }) {
  return <StaticAuthProvider value={DEMO_SESSION}>{children}</StaticAuthProvider>;
}
