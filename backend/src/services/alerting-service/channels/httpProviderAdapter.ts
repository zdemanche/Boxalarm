import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import type { ChannelName } from './channelEnvelope.js';

let cachedSecretsClient: SecretsManagerClient | undefined;

export function createChannelSecretsClient(client?: SecretsManagerClient): SecretsManagerClient {
  cachedSecretsClient ??= client ?? captureAWSv3Client(new SecretsManagerClient({}));
  return cachedSecretsClient;
}

export interface ChannelProviderConfig {
  readonly endpointUrl: string;
  readonly secretId: string;
}

const ENV_PREFIX: Record<ChannelName, string> = { push: 'PUSH', sms: 'SMS', voice: 'VOICE' };

export function readChannelProviderConfig(
  channel: ChannelName,
  env: NodeJS.ProcessEnv,
): ChannelProviderConfig {
  const prefix = ENV_PREFIX[channel];
  const endpointUrl = env[`${prefix}_PROVIDER_ENDPOINT_URL`];
  const secretId = env[`${prefix}_PROVIDER_SECRET_ID`];
  if (!endpointUrl) {
    throw new Error(`${prefix}_PROVIDER_ENDPOINT_URL is required and was not set`);
  }
  if (!secretId) {
    throw new Error(`${prefix}_PROVIDER_SECRET_ID is required and was not set`);
  }
  return { endpointUrl, secretId };
}

const SECRET_CACHE_TTL_MS = 15 * 60 * 1000;
const PROVIDER_REQUEST_TIMEOUT_MS = 4_000;

interface CachedSecret {
  readonly apiKey: string;
  readonly expiresAt: number;
}

const secretCache = new Map<string, CachedSecret>();

export function resetChannelSecretsCache(): void {
  secretCache.clear();
}

async function resolveApiKey(
  channel: ChannelName,
  secretId: string,
  secretsClient: SecretsManagerClient,
): Promise<string> {
  const cached = secretCache.get(channel);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.apiKey;
  }
  const secretOutput = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
  const apiKey = secretOutput.SecretString;
  if (!apiKey) {
    throw new Error(`Secret ${secretId} has no SecretString value`);
  }
  secretCache.set(channel, { apiKey, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
  return apiKey;
}

export async function sendViaHttpProvider(
  channel: ChannelName,
  target: string,
  message: string,
  env: NodeJS.ProcessEnv,
  secretsClient?: SecretsManagerClient,
): Promise<void> {
  const config = readChannelProviderConfig(channel, env);
  const client = createChannelSecretsClient(secretsClient);
  const apiKey = await resolveApiKey(channel, config.secretId, client);
  const response = await fetch(config.endpointUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ target, message }),
    signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${channel} provider responded ${response.status}`);
  }
}
