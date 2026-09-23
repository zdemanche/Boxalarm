export const service = { name: 'incident-service', plane: 'lob' } as const;

export {
  DEFAULT_NERIS_PRODUCTION_HOST,
  NEAR_EXPIRY_SKEW_MS,
  assertNonProductionBaseUrl,
  createNerisClient,
  createSecretsManagerClient,
  createSsmClient,
  createTokenCache,
  getAccessToken,
  isBoxalarmProductionEnvironment,
  readNerisConfig,
  resolveUrl,
  type CreateNerisClientDeps,
  type NerisClient,
  type NerisConfig,
  type TokenCache,
} from './neris/index.js';
