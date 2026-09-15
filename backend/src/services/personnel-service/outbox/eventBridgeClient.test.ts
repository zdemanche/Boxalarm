import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';

describe('readEventBusConfig', () => {
  it('reads the bus name', async () => {
    const { readEventBusConfig } = await import('./eventBridgeClient.js');
    expect(readEventBusConfig({ PLATFORM_BUS_NAME: 'bus-1' })).toEqual({ busName: 'bus-1' });
  });

  it('throws when PLATFORM_BUS_NAME is missing (empty/absent-input row)', async () => {
    const { readEventBusConfig } = await import('./eventBridgeClient.js');
    expect(() => readEventBusConfig({})).toThrow('PLATFORM_BUS_NAME is required');
  });
});

describe('createEventBridgeClient', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_BUS_NAME = 'bus-1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws (fail-closed) instead of returning a client when config is missing', async () => {
    delete process.env.PLATFORM_BUS_NAME;
    const { createEventBridgeClient } = await import('./eventBridgeClient.js');
    expect(() => createEventBridgeClient(process.env)).toThrow('PLATFORM_BUS_NAME is required');
  });

  it('constructs a client once and reuses the same instance across calls', async () => {
    const { createEventBridgeClient } = await import('./eventBridgeClient.js');
    const fakeClient = {} as EventBridgeClient;
    const first = createEventBridgeClient(process.env, fakeClient);
    const second = createEventBridgeClient(process.env);
    expect(first).toBe(fakeClient);
    expect(second).toBe(fakeClient);
  });
});
