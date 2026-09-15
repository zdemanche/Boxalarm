import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { captureAWSv3Client } from 'aws-xray-sdk-core';

export interface EventBusConfig {
  readonly busName: string;
}

export function readEventBusConfig(env: NodeJS.ProcessEnv): EventBusConfig {
  const busName = env.PLATFORM_BUS_NAME;
  if (!busName) {
    throw new Error('PLATFORM_BUS_NAME is required and was not set');
  }
  return { busName };
}

let cachedClient: EventBridgeClient | undefined;

export function createEventBridgeClient(
  env: NodeJS.ProcessEnv,
  client?: EventBridgeClient,
): EventBridgeClient {
  readEventBusConfig(env);
  cachedClient ??= client ?? captureAWSv3Client(new EventBridgeClient({}));
  return cachedClient;
}
