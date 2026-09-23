export interface PersonnelConfig {
  readonly tableName: string;
}

export function readPersonnelConfig(env: NodeJS.ProcessEnv): PersonnelConfig {
  const tableName = env.PERSONNEL_TABLE_NAME;
  if (!tableName) {
    throw new Error('PERSONNEL_TABLE_NAME is required and was not set');
  }
  return { tableName };
}
