import { SNSClient } from '@aws-sdk/client-sns';
import { captureAWSv3Client } from 'aws-xray-sdk-core';

export interface FanOutTopicConfig {
  readonly topicArn: string;
}

export function readFanOutTopicConfig(env: NodeJS.ProcessEnv): FanOutTopicConfig {
  const topicArn = env.ALERTING_TOPIC_ARN;
  if (!topicArn) {
    throw new Error('ALERTING_TOPIC_ARN is required and was not set');
  }
  return { topicArn };
}

let cachedClient: SNSClient | undefined;

export function createSnsClient(env: NodeJS.ProcessEnv, client?: SNSClient): SNSClient {
  readFanOutTopicConfig(env);
  cachedClient ??= client ?? captureAWSv3Client(new SNSClient({}));
  return cachedClient;
}
