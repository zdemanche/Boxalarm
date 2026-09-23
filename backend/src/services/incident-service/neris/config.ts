import { randomUUID } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import xray from 'aws-xray-sdk-core';
import { createLogger } from '@boxalarm/logging';

const logger = createLogger({ service: 'incident-service' });

/**
 * Well-known NERIS production API hostname (N6.4).
 * Overridable via NERIS_PRODUCTION_HOST for tests / alternate fail-closed checks.
 * Never use this host from non-production Boxalarm environments.
 */
export const DEFAULT_NERIS_PRODUCTION_HOST = 'api.neris.fsri.org';

export interface NerisConfig {
  readonly baseUrl: string;
  readonly userAgent: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface AssertNonProductionOptions {
  readonly productionHost?: string;
}

export interface ReadNerisConfigDeps {
  readonly ssmClient?: SSMClient;
  readonly secretsClient?: SecretsManagerClient;
}

/**
 * True when this process is the Boxalarm production deployment.
 * Reads `STAGE` first, then `BOXALARM_ENV` (Moonaan/Pulumi stage naming).
 * Production Boxalarm is allowed to call the NERIS production host (N6.4).
 */
export function isBoxalarmProductionEnvironment(env: NodeJS.ProcessEnv): boolean {
  const stage = (env.STAGE ?? env.BOXALARM_ENV ?? '').trim().toLowerCase();
  return stage === 'prod' || stage === 'production';
}

let cachedSsmClient: SSMClient | undefined;
let cachedSecretsClient: SecretsManagerClient | undefined;

export function createSsmClient(client?: SSMClient): SSMClient {
  cachedSsmClient ??= client ?? xray.captureAWSv3Client(new SSMClient({}));
  return cachedSsmClient;
}

export function createSecretsManagerClient(client?: SecretsManagerClient): SecretsManagerClient {
  cachedSecretsClient ??= client ?? xray.captureAWSv3Client(new SecretsManagerClient({}));
  return cachedSecretsClient;
}

function hostnameOf(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    logger.error({
      event: 'neris.config.base_url_invalid',
      correlationId: randomUUID(),
      message: 'NERIS base URL is not a valid URL',
    });
    throw new Error(`NERIS base URL is not a valid URL: ${baseUrl}`);
  }
  return parsed.hostname.toLowerCase();
}

/**
 * Fail-closed host check (N6.4 / E6-S7 AC4): refuse when the resolved NERIS
 * base URL points at the production host. Callers must invoke this only from
 * non-production Boxalarm environments — see {@link readNerisConfig}.
 */
export function assertNonProductionBaseUrl(
  baseUrl: string,
  options: AssertNonProductionOptions = {},
): void {
  const productionHost = (options.productionHost ?? DEFAULT_NERIS_PRODUCTION_HOST).toLowerCase();
  const host = hostnameOf(baseUrl);
  if (host === productionHost) {
    logger.error({
      event: 'neris.config.production_host_blocked',
      correlationId: randomUUID(),
      resolvedHost: host,
      productionHost,
      message:
        'Resolved NERIS base URL host is the NERIS production host; refusing to start (N6.4)',
    });
    throw new Error(
      `Resolved NERIS base URL host "${host}" is the NERIS production host; refusing to start (N6.4)`,
    );
  }
}

interface NerisCredentialsSecret {
  readonly clientId?: unknown;
  readonly clientSecret?: unknown;
}

async function getSsmString(client: SSMClient, name: string): Promise<string> {
  const output = await client.send(new GetParameterCommand({ Name: name }));
  const value = output.Parameter?.Value;
  if (!value) {
    logger.error({
      event: 'neris.config.ssm_parameter_empty',
      correlationId: randomUUID(),
      paramName: name,
    });
    throw new Error(`SSM parameter ${name} has no Value`);
  }
  return value;
}

function parseCredentials(
  secretId: string,
  secretString: string,
): {
  clientId: string;
  clientSecret: string;
} {
  let parsed: NerisCredentialsSecret;
  try {
    parsed = JSON.parse(secretString) as NerisCredentialsSecret;
  } catch {
    logger.error({
      event: 'neris.config.credentials_secret_invalid_json',
      correlationId: randomUUID(),
      secretId,
    });
    throw new Error(`Secret ${secretId} is not valid JSON`);
  }
  if (typeof parsed.clientId !== 'string' || parsed.clientId.length === 0) {
    logger.error({
      event: 'neris.config.credentials_secret_missing_field',
      correlationId: randomUUID(),
      secretId,
      field: 'clientId',
    });
    throw new Error(`Secret ${secretId} is missing required string field clientId`);
  }
  if (typeof parsed.clientSecret !== 'string' || parsed.clientSecret.length === 0) {
    logger.error({
      event: 'neris.config.credentials_secret_missing_field',
      correlationId: randomUUID(),
      secretId,
      field: 'clientSecret',
    });
    throw new Error(`Secret ${secretId} is missing required string field clientSecret`);
  }
  return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
}

async function loadNerisConfig(
  env: NodeJS.ProcessEnv,
  deps: ReadNerisConfigDeps,
): Promise<NerisConfig> {
  const baseUrlParam = env.NERIS_BASE_URL_PARAM;
  const userAgentParam = env.NERIS_USER_AGENT_PARAM;
  const credentialsSecretId = env.NERIS_CREDENTIALS_SECRET_ID;

  if (!baseUrlParam) {
    logger.error({
      event: 'neris.config.missing_env',
      correlationId: randomUUID(),
      paramName: 'NERIS_BASE_URL_PARAM',
    });
    throw new Error('NERIS_BASE_URL_PARAM is required and was not set');
  }
  if (!userAgentParam) {
    logger.error({
      event: 'neris.config.missing_env',
      correlationId: randomUUID(),
      paramName: 'NERIS_USER_AGENT_PARAM',
    });
    throw new Error('NERIS_USER_AGENT_PARAM is required and was not set');
  }
  if (!credentialsSecretId) {
    logger.error({
      event: 'neris.config.missing_env',
      correlationId: randomUUID(),
      paramName: 'NERIS_CREDENTIALS_SECRET_ID',
    });
    throw new Error('NERIS_CREDENTIALS_SECRET_ID is required and was not set');
  }

  const ssm = createSsmClient(deps.ssmClient);
  const secrets = createSecretsManagerClient(deps.secretsClient);

  const [baseUrl, userAgent] = await Promise.all([
    getSsmString(ssm, baseUrlParam),
    getSsmString(ssm, userAgentParam),
  ]);

  if (!isBoxalarmProductionEnvironment(env)) {
    assertNonProductionBaseUrl(
      baseUrl,
      env.NERIS_PRODUCTION_HOST ? { productionHost: env.NERIS_PRODUCTION_HOST } : {},
    );
  }

  const secretOutput = await secrets.send(
    new GetSecretValueCommand({ SecretId: credentialsSecretId }),
  );
  if (!secretOutput.SecretString) {
    logger.error({
      event: 'neris.config.credentials_secret_empty',
      correlationId: randomUUID(),
      secretId: credentialsSecretId,
    });
    throw new Error(`Secret ${credentialsSecretId} has no SecretString value`);
  }
  const { clientId, clientSecret } = parseCredentials(
    credentialsSecretId,
    secretOutput.SecretString,
  );

  return { baseUrl, userAgent, clientId, clientSecret };
}

let cachedConfigPromise: Promise<NerisConfig> | undefined;

/**
 * Loads per-environment NERIS config from SSM (base URL, User-Agent) and
 * Secrets Manager (OAuth2 client credentials). Never hardcodes those values.
 * In non-production Boxalarm environments, asserts the resolved base URL is
 * not the NERIS production host (N6.4). Production Boxalarm may use it.
 *
 * The resolved config is cached at module scope (mirroring {@link createSsmClient}
 * / {@link createSecretsManagerClient}) so SSM and Secrets Manager are hit once
 * per warm container rather than once per invocation. Concurrent callers that
 * observe no cached config yet coalesce onto the same in-flight load. A failed
 * load is not cached, so the next call retries.
 */
export function readNerisConfig(
  env: NodeJS.ProcessEnv,
  deps: ReadNerisConfigDeps = {},
): Promise<NerisConfig> {
  if (!cachedConfigPromise) {
    cachedConfigPromise = loadNerisConfig(env, deps).catch((error: unknown) => {
      cachedConfigPromise = undefined;
      throw error;
    });
  }
  return cachedConfigPromise;
}
