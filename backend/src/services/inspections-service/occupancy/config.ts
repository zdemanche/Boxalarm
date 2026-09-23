export interface OccupancyServiceConfig {
  readonly tableName: string;
}

export function readOccupancyServiceConfig(env: NodeJS.ProcessEnv): OccupancyServiceConfig {
  const tableName = env.OCCUPANCY_TABLE_NAME;
  if (!tableName) {
    throw new Error('OCCUPANCY_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

export interface OccupancyAuthorizationConfig {
  readonly policyStoreId: string;
}

export function readOccupancyAuthorizationConfig(
  env: NodeJS.ProcessEnv,
): OccupancyAuthorizationConfig {
  const policyStoreId = env.VERIFIED_PERMISSIONS_POLICY_STORE_ID;
  if (!policyStoreId) {
    throw new Error('VERIFIED_PERMISSIONS_POLICY_STORE_ID is required and was not set');
  }
  return { policyStoreId };
}
