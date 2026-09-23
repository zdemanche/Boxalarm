export interface MemberServiceConfig {
  readonly tableName: string;
}

export function readMemberServiceConfig(env: NodeJS.ProcessEnv): MemberServiceConfig {
  const tableName = env.PLATFORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return { tableName };
}
