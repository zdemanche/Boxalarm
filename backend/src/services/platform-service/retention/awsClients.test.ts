import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('aws-xray-sdk-core', () => ({
  captureAWSv3Client: <T>(client: T): T => client,
}));

describe('retention awsClients', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns an injected DynamoDBDocumentClient without constructing one', async () => {
    const { getDynamoDocClient } = await import('./awsClients.js');
    const injected = { send: vi.fn() } as never;
    expect(getDynamoDocClient(injected)).toBe(injected);
  });

  it('returns an injected KMSClient without constructing one', async () => {
    const { getKmsClient } = await import('./awsClients.js');
    const injected = { send: vi.fn() } as never;
    expect(getKmsClient(injected)).toBe(injected);
  });
});
