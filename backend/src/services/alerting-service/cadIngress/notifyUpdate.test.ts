import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import { notifyUpdate, setLambdaClient } from './notifyUpdate.js';

describe('notifyUpdate', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    setLambdaClient(undefined);
    vi.restoreAllMocks();
  });

  const NOTICE = { deptId: 'nichols-fd', dispatchId: 'd-1', updateId: 'a'.repeat(32) };

  it('invokes the notifier asynchronously with the notice only', async () => {
    process.env.CAD_UPDATE_NOTIFIER_FUNCTION = 'boxalarm-dev-alerting-cad-update-notifier';
    const send = vi.fn().mockResolvedValue({ StatusCode: 202 });
    setLambdaClient({ send } as unknown as LambdaClient);
    await notifyUpdate(NOTICE);
    const input = (send.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({
      FunctionName: 'boxalarm-dev-alerting-cad-update-notifier',
      InvocationType: 'Event',
    });
    expect(JSON.parse(Buffer.from(input.Payload as Uint8Array).toString())).toEqual(NOTICE);
  });

  it('never throws: a failed hand-off is logged and counted (the update is already recorded)', async () => {
    process.env.CAD_UPDATE_NOTIFIER_FUNCTION = 'fn';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setLambdaClient({
      send: vi.fn().mockRejectedValue(new Error('throttled')),
    } as unknown as LambdaClient);
    await expect(notifyUpdate(NOTICE)).resolves.toBeUndefined();
    expect(
      vi
        .mocked(console.log)
        .mock.calls.some(([l]) => String(l).includes('"CadUpdatePushFailed":1')),
    ).toBe(true);
  });
});
