import { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';

export interface AuthzConfig {
  readonly policyStoreId: string;
}

export function readAuthzConfig(env: NodeJS.ProcessEnv): AuthzConfig {
  const policyStoreId = env.VERIFIED_PERMISSIONS_POLICY_STORE_ID;
  if (!policyStoreId) {
    throw new Error('VERIFIED_PERMISSIONS_POLICY_STORE_ID is required and was not set');
  }
  return { policyStoreId };
}

let cachedClient: VerifiedPermissionsClient | undefined;

export function createAuthzClient(
  env: NodeJS.ProcessEnv,
  client?: VerifiedPermissionsClient,
): VerifiedPermissionsClient {
  readAuthzConfig(env);
  cachedClient ??= client ?? new VerifiedPermissionsClient({});
  return cachedClient;
}
