import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SNSClient } from '@aws-sdk/client-sns';

describe('readFanOutTopicConfig', () => {
  it('reads the topic ARN', async () => {
    const { readFanOutTopicConfig } = await import('./snsClient.js');
    expect(
      readFanOutTopicConfig({
        ALERTING_TOPIC_ARN: 'arn:aws:sns:us-east-1:1:boxalarm-dev-alerting-topic.fifo',
      }),
    ).toEqual({ topicArn: 'arn:aws:sns:us-east-1:1:boxalarm-dev-alerting-topic.fifo' });
  });

  it('throws when ALERTING_TOPIC_ARN is missing (empty/absent-input row)', async () => {
    const { readFanOutTopicConfig } = await import('./snsClient.js');
    expect(() => readFanOutTopicConfig({})).toThrow('ALERTING_TOPIC_ARN is required');
  });
});

describe('createSnsClient', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TOPIC_ARN = 'arn:aws:sns:us-east-1:1:boxalarm-dev-alerting-topic.fifo';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws (fail-closed) instead of returning a client when config is missing', async () => {
    delete process.env.ALERTING_TOPIC_ARN;
    const { createSnsClient } = await import('./snsClient.js');
    expect(() => createSnsClient(process.env)).toThrow('ALERTING_TOPIC_ARN is required');
  });

  it('constructs a client once and reuses the same instance across calls', async () => {
    const { createSnsClient } = await import('./snsClient.js');
    const fakeClient = {} as SNSClient;
    const first = createSnsClient(process.env, fakeClient);
    const second = createSnsClient(process.env);
    expect(first).toBe(fakeClient);
    expect(second).toBe(fakeClient);
  });
});
