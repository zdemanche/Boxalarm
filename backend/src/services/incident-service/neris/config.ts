import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import xray from 'aws-xray-sdk-core';

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
    throw new Error(`Secret ${secretId} is not valid JSON`);
  }
  if (typeof parsed.clientId !== 'string' || parsed.clientId.length === 0) {
    throw new Error(`Secret ${secretId} is missing required string field clientId`);
  }
  if (typeof parsed.clientSecret !== 'string' || parsed.clientSecret.length === 0) {
    throw new Error(`Secret ${secretId} is missing required string field clientSecret`);
  }
  return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
}

/**
 * Loads per-environment NERIS config from SSM (base URL, User-Agent) and
 * Secrets Manager (OAuth2 client credentials). Never hardcodes those values.
 * In non-production Boxalarm environments, asserts the resolved base URL is
 * not the NERIS production host (N6.4). Production Boxalarm may use it.
 */
export async function readNerisConfig(
  env: NodeJS.ProcessEnv,
  deps: ReadNerisConfigDeps = {},
): Promise<NerisConfig> {
  const baseUrlParam = env.NERIS_BASE_URL_PARAM;
  const userAgentParam = env.NERIS_USER_AGENT_PARAM;
  const credentialsSecretId = env.NERIS_CREDENTIALS_SECRET_ID;

  if (!baseUrlParam) {
    throw new Error('NERIS_BASE_URL_PARAM is required and was not set');
  }
  if (!userAgentParam) {
    throw new Error('NERIS_USER_AGENT_PARAM is required and was not set');
  }
  if (!credentialsSecretId) {
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
    throw new Error(`Secret ${credentialsSecretId} has no SecretString value`);
  }
  const { clientId, clientSecret } = parseCredentials(
    credentialsSecretId,
    secretOutput.SecretString,
  );

  return { baseUrl, userAgent, clientId, clientSecret };
}
