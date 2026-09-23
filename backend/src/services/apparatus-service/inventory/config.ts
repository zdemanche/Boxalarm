export interface PlatformTableConfig {
  readonly tableName: string;
}

export function readPlatformTableConfig(env: NodeJS.ProcessEnv): PlatformTableConfig {
  const tableName = env.PLATFORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return { tableName };
}
