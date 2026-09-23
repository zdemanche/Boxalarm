import { beforeEach, describe, expect, it, vi } from 'vitest';

const captureAWSv3Client = vi.fn((client: unknown) => client);

vi.mock('aws-xray-sdk-core', () => ({
  captureAWSv3Client: (client: unknown) => captureAWSv3Client(client),
}));

beforeEach(() => {
  vi.resetModules();
  captureAWSv3Client.mockClear();
});

describe('awsClients', () => {
  it('constructs and caches a real, X-Ray-wrapped DynamoDB document client', async () => {
    const { getDynamoDocClient } = await import('./awsClients.js');
    const first = getDynamoDocClient();
    const second = getDynamoDocClient();
    expect(first).toBeDefined();
    expect(second).toBe(first);
    // The doc client wraps a DynamoDBClient, which is the thing actually passed
    // through X-Ray capture — assert the wrapping happened, not just that a
    // client object exists (a plain unwrapped client would pass that check too).
    expect(captureAWSv3Client).toHaveBeenCalledTimes(1);
  });

  it('constructs and caches a real, X-Ray-wrapped S3 client', async () => {
    const { getS3Client } = await import('./awsClients.js');
    const first = getS3Client();
    const second = getS3Client();
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(captureAWSv3Client).toHaveBeenCalledTimes(1);
  });

  it('constructs and caches a real, X-Ray-wrapped Lambda client', async () => {
    const { getLambdaClient } = await import('./awsClients.js');
    const first = getLambdaClient();
    const second = getLambdaClient();
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(captureAWSv3Client).toHaveBeenCalledTimes(1);
  });
});
