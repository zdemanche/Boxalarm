import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ marker: 'raw-client' })),
}));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: vi.fn().mockImplementation((raw: unknown) => ({ raw })) },
}));
vi.mock('aws-xray-sdk-core', () => ({
  captureAWSv3Client: vi.fn().mockImplementation((raw: unknown) => raw),
}));

describe('getDynamoDocumentClient (production default path)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('constructs an X-Ray-instrumented DynamoDBDocumentClient when called with no override, caching it on a second call', async () => {
    const { getDynamoDocumentClient } = await import('./dynamoClient.js');
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
    const { captureAWSv3Client } = await import('aws-xray-sdk-core');

    const first = getDynamoDocumentClient();
    const second = getDynamoDocumentClient();

    expect(DynamoDBClient).toHaveBeenCalledTimes(1);
    expect(captureAWSv3Client).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- `from` is a vi.fn() mock, not a real class method
    expect(DynamoDBDocumentClient.from).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });
});
