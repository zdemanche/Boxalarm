import { describe, expect, it } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { handler as livenessHandler } from './liveness.js';
import { checkReadiness } from './readiness.js';

describe('liveness', () => {
  it('returns 200 unauthenticated with no dependency call (§4.3)', async () => {
    const result = await livenessHandler();
    expect(result).toMatchObject({ statusCode: 200 });
  });
});

describe('readiness', () => {
  it('returns 200 when the DynamoDB hard dependency responds (§4.3)', async () => {
    const client = { send: () => Promise.resolve({}) } as unknown as DynamoDBClient;

    const result = await checkReadiness({ PLATFORM_TABLE_NAME: 'platform-table' }, { client });

    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('returns 503 when the DynamoDB hard dependency is unreachable (§4.3)', async () => {
    const client = {
      send: () => Promise.reject(new Error('table unavailable')),
    } as unknown as DynamoDBClient;

    const result = await checkReadiness({ PLATFORM_TABLE_NAME: 'platform-table' }, { client });

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 503 when PLATFORM_TABLE_NAME is unset, without constructing a client', async () => {
    const result = await checkReadiness({});

    expect(result).toMatchObject({ statusCode: 503 });
  });
});
