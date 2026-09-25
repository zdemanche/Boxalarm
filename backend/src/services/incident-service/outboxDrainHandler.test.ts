import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { handler } from './outboxDrainHandler.js';

describe('incident-service outboxDrainHandler', () => {
  beforeEach(() => {
    process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-dev-platform-bus';
    process.env.PLATFORM_TABLE_NAME = 'boxalarm-dev-incident';
  });

  afterEach(() => {
    delete process.env.PLATFORM_EVENT_BUS_NAME;
    delete process.env.PLATFORM_TABLE_NAME;
  });

  it('is the shared @boxalarm/outbox drain handler, exercised as the exported Lambda entrypoint with no records', async () => {
    const event: DynamoDBStreamEvent = { Records: [] };

    const result = await handler(event, {} as never, () => undefined);

    expect(result).toEqual({ batchItemFailures: [] });
  });
});
