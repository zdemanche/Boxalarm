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

export interface OutboxPublisherConfig extends MemberServiceConfig {
  readonly busName: string;
}

export function readOutboxPublisherConfig(env: NodeJS.ProcessEnv): OutboxPublisherConfig {
  const busName = env.PLATFORM_BUS_NAME;
  if (!busName) {
    throw new Error('PLATFORM_BUS_NAME is required and was not set');
  }
  return { ...readMemberServiceConfig(env), busName };
}
