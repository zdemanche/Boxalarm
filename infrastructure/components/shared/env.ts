/**
 * Single source of truth for environment validation. Previously reimplemented
 * inconsistently across 6+ files: the data-layer components (alerting-table,
 * incident-table, platform-table, audit-trail) and neris-config rejected an unknown
 * env against a fixed list, while http-api and service-lambda accepted any non-empty
 * string. That meant a stack configured with a typo'd env (e.g. "production") would
 * be silently accepted by the API layer and rejected by the data layer. This uses the
 * stricter behavior everywhere: unknown envs are rejected against KNOWN_ENVS.
 */
export const KNOWN_ENVS = new Set(["dev", "qa", "staging", "prod"]);

export function requireEnv(component: string, env: string): void {
  if (typeof env !== "string" || env.length === 0) {
    throw new Error(`${component}: env is required (received ${JSON.stringify(env)})`);
  }
  if (!KNOWN_ENVS.has(env)) {
    throw new Error(`${component}: unknown env "${env}"`);
  }
}
